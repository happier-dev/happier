import { eventRouter, buildNewArtifactUpdate, buildUpdateArtifactUpdate, buildDeleteArtifactUpdate } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { Fastify } from "../../types";
import { z } from "zod";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { log } from "@/utils/logging/log";
import * as privacyKit from "privacy-kit";
import { createArtifact, deleteArtifact, updateArtifact } from "@/app/artifacts/artifactWriteService";
import { artifactOrdinaryWhere } from "@/app/artifacts/artifactClassification";
import {
    isPlainArtifactDataKeyBytes,
    openArtifactStoredContentBytes,
    openArtifactStoredContentPair,
} from "@/app/artifacts/artifactStoredContent";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import {
    buildAccountStoredContentUpgradeRequired,
    enforceCurrentAccountStoredContentCompatibilityForHttpRequest,
    readAccountStoredContentCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import {
    AccountStoredContentUpgradeRequiredV1Schema,
    CLIENT_UPGRADE_REQUIRED_HTTP_STATUS,
} from "@happier-dev/protocol";

const DEFAULT_ARTIFACT_LIST_LIMIT = 500;

export function artifactsRoutes(app: Fastify) {
    // GET /v1/artifacts - List all artifacts for the account
    app.get('/v1/artifacts', {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "artifacts"),
        },
        schema: {
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(500).optional(),
            }),
            response: {
                200: z.array(z.object({
                    id: z.string(),
                    header: z.string(),
                    headerVersion: z.number(),
                    dataEncryptionKey: z.string(),
                    seq: z.number(),
                    createdAt: z.number(),
                    updatedAt: z.number()
                })),
                426: AccountStoredContentUpgradeRequiredV1Schema,
                500: z.object({
                    error: z.literal('Failed to get artifacts')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const query = request.query as { limit?: number };
        const listLimit = typeof query.limit === "number" ? query.limit : DEFAULT_ARTIFACT_LIST_LIMIT;

        try {
            const artifacts = await db.artifact.findMany({
                where: {
                    accountId: userId,
                    ...artifactOrdinaryWhere,
                },
                orderBy: { updatedAt: 'desc' },
                take: listLimit,
                select: {
                    id: true,
                    header: true,
                    headerVersion: true,
                    dataEncryptionKey: true,
                    seq: true,
                    createdAt: true,
                    updatedAt: true
                }
            });
            if (
                artifacts.some((artifact) =>
                    isPlainArtifactDataKeyBytes(
                        artifact.dataEncryptionKey,
                    ))
                && !await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                    request,
                    reply,
                )
            ) {
                return;
            }

            const projected = artifacts.map((artifact) => {
                const header = openArtifactStoredContentBytes({
                    accountId: userId,
                    artifactId: artifact.id,
                    field: "header",
                    dataEncryptionKey: artifact.dataEncryptionKey,
                    content: artifact.header,
                });
                if (!header) {
                    throw new Error("Artifact header could not be opened");
                }
                return {
                    id: artifact.id,
                    header: privacyKit.encodeBase64(header),
                    headerVersion: artifact.headerVersion,
                    dataEncryptionKey: privacyKit.encodeBase64(artifact.dataEncryptionKey),
                    seq: artifact.seq,
                    createdAt: artifact.createdAt.getTime(),
                    updatedAt: artifact.updatedAt.getTime(),
                };
            });
            return reply.send(projected);
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to get artifacts: ${error}`);
            return reply.code(500).send({ error: 'Failed to get artifacts' });
        }
    });

    // GET /v1/artifacts/:id - Get single artifact with full body
    app.get('/v1/artifacts/:id', {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "artifacts"),
        },
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: z.object({
                    id: z.string(),
                    header: z.string(),
                    headerVersion: z.number(),
                    body: z.string(),
                    bodyVersion: z.number(),
                    dataEncryptionKey: z.string(),
                    seq: z.number(),
                    createdAt: z.number(),
                    updatedAt: z.number()
                }),
                404: z.object({
                    error: z.literal('Artifact not found')
                }),
                500: z.object({
                    error: z.literal('Failed to get artifact')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        try {
            const artifact = await db.artifact.findFirst({
                where: {
                    id,
                    accountId: userId,
                    ...artifactOrdinaryWhere,
                }
            });

            if (!artifact) {
                return reply.code(404).send({ error: 'Artifact not found' });
            }
            if (
                isPlainArtifactDataKeyBytes(
                    artifact.dataEncryptionKey,
                )
                && !await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                    request,
                    reply,
                )
            ) {
                return;
            }
            const opened = openArtifactStoredContentPair({
                accountId: userId,
                artifactId: artifact.id,
                dataEncryptionKey: artifact.dataEncryptionKey,
                header: artifact.header,
                body: artifact.body,
            });
            if (!opened) {
                throw new Error("Artifact content could not be opened");
            }

            return reply.send({
                id: artifact.id,
                header: privacyKit.encodeBase64(opened.header),
                headerVersion: artifact.headerVersion,
                body: privacyKit.encodeBase64(opened.body),
                bodyVersion: artifact.bodyVersion,
                dataEncryptionKey: privacyKit.encodeBase64(artifact.dataEncryptionKey),
                seq: artifact.seq,
                createdAt: artifact.createdAt.getTime(),
                updatedAt: artifact.updatedAt.getTime()
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to get artifact: ${error}`);
            return reply.code(500).send({ error: 'Failed to get artifact' });
        }
    });

    // POST /v1/artifacts - Create new artifact
    app.post('/v1/artifacts', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                id: z.string().uuid(),
                header: z.string(),
                body: z.string(),
                dataEncryptionKey: z.string()
            }),
            response: {
                200: z.object({
                    id: z.string(),
                    header: z.string(),
                    headerVersion: z.number(),
                    body: z.string(),
                    bodyVersion: z.number(),
                    dataEncryptionKey: z.string(),
                    seq: z.number(),
                    createdAt: z.number(),
                    updatedAt: z.number()
                }),
                409: z.object({
                    error: z.literal('Artifact with this ID already exists for another account')
                }),
                400: z.object({
                    error: z.literal('Invalid parameters')
                }),
                426: AccountStoredContentUpgradeRequiredV1Schema,
                500: z.object({
                    error: z.literal('Failed to create artifact')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id, header, body, dataEncryptionKey } = request.body;
        const compatibility =
            readAccountStoredContentCompatibilityForHttpRequest(
                request,
            );

        try {
            log({ module: 'api', artifactId: id, userId }, 'Creating artifact');
            const result = await createArtifact({
                actorUserId: userId,
                artifactId: id,
                header: privacyKit.decodeBase64(header),
                body: privacyKit.decodeBase64(body),
                dataEncryptionKey: privacyKit.decodeBase64(dataEncryptionKey),
                supportsCurrentStoredContentProtocol:
                    compatibility.supportsCurrentProtocol,
            });

            if (!result.ok) {
                if (result.error === 'invalid-params') {
                    return reply.code(400).send({ error: 'Invalid parameters' });
                }
                if (result.error === 'conflict') {
                    return reply.code(409).send({
                        error: 'Artifact with this ID already exists for another account'
                    });
                }
                if (
                    result.error
                    === 'client-upgrade-required'
                ) {
                    if (
                        !await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                            request,
                            reply,
                        )
                    ) {
                        return;
                    }
                    return reply
                        .code(
                            CLIENT_UPGRADE_REQUIRED_HTTP_STATUS,
                        )
                        .send(
                            buildAccountStoredContentUpgradeRequired(),
                        );
                }
                return reply.code(500).send({ error: 'Failed to create artifact' });
            }

            if (result.didWrite) {
                const newArtifactPayload = buildNewArtifactUpdate(result.artifact, result.cursor, randomKeyNaked(12));
                eventRouter.emitUpdate({
                    userId,
                    payload: newArtifactPayload,
                    recipientFilter: { type: 'user-scoped-only' }
                });
            } else {
                log({ module: 'api', artifactId: id, userId }, 'Found existing artifact');
            }

            return reply.send({
                id: result.artifact.id,
                header: Buffer.from(result.artifact.header).toString('base64'),
                headerVersion: result.artifact.headerVersion,
                body: Buffer.from(result.artifact.body).toString('base64'),
                bodyVersion: result.artifact.bodyVersion,
                dataEncryptionKey: Buffer.from(result.artifact.dataEncryptionKey).toString('base64'),
                seq: result.artifact.seq,
                createdAt: result.artifact.createdAt.getTime(),
                updatedAt: result.artifact.updatedAt.getTime()
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to create artifact: ${error}`);
            return reply.code(500).send({ error: 'Failed to create artifact' });
        }
    });

    // POST /v1/artifacts/:id - Update artifact with version control
    app.post('/v1/artifacts/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            body: z.object({
                header: z.string().optional(),
                expectedHeaderVersion: z.number().int().min(0).optional(),
                body: z.string().optional(),
                expectedBodyVersion: z.number().int().min(0).optional()
            }),
            response: {
                200: z.union([
                    z.object({
                        success: z.literal(true),
                        headerVersion: z.number().optional(),
                        bodyVersion: z.number().optional()
                    }),
                    z.object({
                        success: z.literal(false),
                        error: z.literal('version-mismatch'),
                        currentHeaderVersion: z.number().optional(),
                        currentBodyVersion: z.number().optional(),
                        currentHeader: z.string().optional(),
                        currentBody: z.string().optional()
                    })
                ]),
                400: z.object({
                    error: z.literal('Invalid parameters')
                }),
                404: z.object({
                    error: z.literal('Artifact not found')
                }),
                426: AccountStoredContentUpgradeRequiredV1Schema,
                500: z.object({
                    error: z.literal('Failed to update artifact')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        const { header, expectedHeaderVersion, body, expectedBodyVersion } = request.body;
        const compatibility =
            readAccountStoredContentCompatibilityForHttpRequest(
                request,
            );

        try {
            if (header !== undefined && expectedHeaderVersion === undefined) {
                return reply.code(400).send({ error: 'Invalid parameters' });
            }
            if (body !== undefined && expectedBodyVersion === undefined) {
                return reply.code(400).send({ error: 'Invalid parameters' });
            }

            const headerParam = header !== undefined && expectedHeaderVersion !== undefined
                ? { bytes: privacyKit.decodeBase64(header), expectedVersion: expectedHeaderVersion }
                : undefined;
            const bodyParam = body !== undefined && expectedBodyVersion !== undefined
                ? { bytes: privacyKit.decodeBase64(body), expectedVersion: expectedBodyVersion }
                : undefined;

            if (!headerParam && !bodyParam) {
                return reply.code(400).send({ error: 'Invalid parameters' });
            }

            const result = await updateArtifact({
                actorUserId: userId,
                artifactId: id,
                header: headerParam,
                body: bodyParam,
                supportsCurrentStoredContentProtocol:
                    compatibility.supportsCurrentProtocol,
            });

            if (!result.ok) {
                if (result.error === 'invalid-params') {
                    return reply.code(400).send({ error: 'Invalid parameters' });
                }
                if (result.error === 'not-found') {
                    return reply.code(404).send({ error: 'Artifact not found' });
                }
                if (
                    result.error
                    === 'client-upgrade-required'
                ) {
                    if (
                        !await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                            request,
                            reply,
                        )
                    ) {
                        return;
                    }
                    return reply
                        .code(
                            CLIENT_UPGRADE_REQUIRED_HTTP_STATUS,
                        )
                        .send(
                            buildAccountStoredContentUpgradeRequired(),
                        );
                }
                if (result.error === 'version-mismatch') {
                    return reply.send({
                        success: false as const,
                        error: 'version-mismatch' as const,
                        ...(headerParam && result.current && {
                            currentHeaderVersion: result.current.headerVersion,
                            currentHeader: Buffer.from(result.current.header).toString('base64'),
                        }),
                        ...(bodyParam && result.current && {
                            currentBodyVersion: result.current.bodyVersion,
                            currentBody: Buffer.from(result.current.body).toString('base64'),
                        }),
                    });
                }
                return reply.code(500).send({ error: 'Failed to update artifact' });
            }

            const headerUpdate = headerParam && result.header
                ? { value: header!, version: result.header.version }
                : undefined;
            const bodyUpdate = bodyParam && result.body
                ? { value: body!, version: result.body.version }
                : undefined;

            const updatePayload = buildUpdateArtifactUpdate(id, result.cursor, randomKeyNaked(12), headerUpdate, bodyUpdate);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({
                success: true as const,
                ...(headerUpdate && { headerVersion: headerUpdate.version }),
                ...(bodyUpdate && { bodyVersion: bodyUpdate.version }),
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to update artifact: ${error}`);
            return reply.code(500).send({ error: 'Failed to update artifact' });
        }
    });

    // DELETE /v1/artifacts/:id - Delete artifact
    app.delete('/v1/artifacts/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                404: z.object({
                    error: z.literal('Artifact not found')
                }),
                426: AccountStoredContentUpgradeRequiredV1Schema,
                500: z.object({
                    error: z.literal('Failed to delete artifact')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        const compatibility =
            readAccountStoredContentCompatibilityForHttpRequest(
                request,
            );

        try {
            const result = await deleteArtifact({
                actorUserId: userId,
                artifactId: id,
                supportsCurrentStoredContentProtocol:
                    compatibility.supportsCurrentProtocol,
            });
            if (!result.ok) {
                if (result.error === 'not-found') {
                    return reply.code(404).send({ error: 'Artifact not found' });
                }
                if (
                    result.error
                    === 'client-upgrade-required'
                ) {
                    if (
                        !await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                            request,
                            reply,
                        )
                    ) {
                        return;
                    }
                    return reply
                        .code(
                            CLIENT_UPGRADE_REQUIRED_HTTP_STATUS,
                        )
                        .send(
                            buildAccountStoredContentUpgradeRequired(),
                        );
                }
                return reply.code(500).send({ error: 'Failed to delete artifact' });
            }

            const deletePayload = buildDeleteArtifactUpdate(id, result.cursor, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId,
                payload: deletePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({ success: true });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to delete artifact: ${error}`);
            return reply.code(500).send({ error: 'Failed to delete artifact' });
        }
    });
}
