import {
    AccountStoredContentUpgradeRequiredV1Schema,
} from "@happier-dev/protocol";
import * as privacyKit from "privacy-kit";
import { z } from "zod";
import { Fastify } from "../../types";
import { kvGet } from "@/app/kv/kvGet";
import { kvList } from "@/app/kv/kvList";
import { kvBulkGet } from "@/app/kv/kvBulkGet";
import { kvMutate } from "@/app/kv/kvMutate";
import {
    enforceCurrentAccountStoredContentCompatibilityForHttpRequest,
    readAccountStoredContentCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import {
    assertTodoKvStoredContentMatchesAccountMode,
    classifyTodoKvStoredContent,
    isTodoKvKey,
    TodoKvStoredContentModeMismatchError,
    TodoKvStoredContentUpgradeRequiredError,
} from "@/app/kv/todoKvStoredContent";
import {
    deriveAccountEncryptionCurrentnessFromRow,
} from "@/app/encryption/accountContentKeyAdmission";
import { AccountScopedKvReservedKeyError } from "@/app/kv/accountScopedKv";
import { db } from "@/storage/db";
import { log } from "@/utils/logging/log";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";

function containsCurrentTodoStoredContent(
    items: ReadonlyArray<Readonly<{ key: string; value: string }>>,
): boolean {
    return items.some((item) => {
        if (!isTodoKvKey(item.key)) {
            return false;
        }
        const classification = classifyTodoKvStoredContent({
            key: item.key,
            value: privacyKit.decodeBase64(item.value),
        });
        return classification.domain === "todo"
            && classification.representation.startsWith("current_");
    });
}

async function assertTodoKvReadStoredContentMatchesAccount(
    accountId: string,
    items: ReadonlyArray<Readonly<{ key: string; value: string }>>,
): Promise<void> {
    const todoItems = items.filter((item) => isTodoKvKey(item.key));
    if (todoItems.length === 0) return;

    const account = await db.account.findUnique({
        where: { id: accountId },
        select: {
            encryptionMode: true,
            publicKey: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    });
    const currentness = account
        ? deriveAccountEncryptionCurrentnessFromRow(account)
        : null;
    if (!currentness || currentness.status !== "ready") {
        throw new TodoKvStoredContentModeMismatchError();
    }
    for (const item of todoItems) {
        assertTodoKvStoredContentMatchesAccountMode({
            key: item.key,
            value: privacyKit.decodeBase64(item.value),
            accountMode: currentness.currentness.encryptionMode,
        });
    }
}

export function kvRoutes(app: Fastify) {
    // GET /v1/kv/:key - Get single value
    app.get('/v1/kv/:key', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                key: z.string()
            }),
            response: {
                200: z.object({
                    key: z.string(),
                    value: z.string(),
                    version: z.number()
                }).nullable(),
                404: z.object({
                    error: z.literal('Key not found')
                }),
                400: z.object({
                    error: z.literal('Invalid parameters')
                }),
                426: AccountStoredContentUpgradeRequiredV1Schema,
                500: z.object({
                    error: z.literal('Failed to get value')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { key } = request.params;

        try {
            const result = await kvGet({ uid: userId }, key);

            if (!result) {
                return reply.code(404).send({ error: 'Key not found' });
            }
            await assertTodoKvReadStoredContentMatchesAccount(
                userId,
                [result],
            );
            if (
                containsCurrentTodoStoredContent([result])
                && !readAccountStoredContentCompatibilityForHttpRequest(request)
                    .supportsCurrentProtocol
            ) {
                await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                    request,
                    reply,
                );
                return;
            }

            return reply.send(result);
        } catch (error) {
            if (error instanceof AccountScopedKvReservedKeyError) {
                return reply.code(400).send({ error: 'Invalid parameters' });
            }
            if (error instanceof TodoKvStoredContentModeMismatchError) {
                return reply.code(400).send({ error: 'Invalid parameters' });
            }
            log({ module: 'api', level: 'error' }, `Failed to get KV value: ${error}`);
            return reply.code(500).send({ error: 'Failed to get value' });
        }
    });

    // GET /v1/kv - List key-value pairs with optional prefix filter
    app.get('/v1/kv', {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "kv.list"),
        },
        schema: {
            querystring: z.object({
                prefix: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(1000).default(100)
            }),
            response: {
                200: z.object({
                    items: z.array(z.object({
                        key: z.string(),
                        value: z.string(),
                        version: z.number()
                    }))
                }),
                400: z.object({
                    error: z.literal('Invalid parameters')
                }),
                426: AccountStoredContentUpgradeRequiredV1Schema,
                500: z.object({
                    error: z.literal('Failed to list items')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { prefix, limit } = request.query;

        try {
            const result = await kvList({ uid: userId }, { prefix, limit });
            await assertTodoKvReadStoredContentMatchesAccount(
                userId,
                result.items,
            );
            if (
                containsCurrentTodoStoredContent(result.items)
                && !readAccountStoredContentCompatibilityForHttpRequest(request)
                    .supportsCurrentProtocol
            ) {
                await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                    request,
                    reply,
                );
                return;
            }
            return reply.send(result);
        } catch (error) {
            if (error instanceof AccountScopedKvReservedKeyError) {
                return reply.code(400).send({ error: 'Invalid parameters' });
            }
            if (error instanceof TodoKvStoredContentModeMismatchError) {
                return reply.code(400).send({ error: 'Invalid parameters' });
            }
            log({ module: 'api', level: 'error' }, `Failed to list KV items: ${error}`);
            return reply.code(500).send({ error: 'Failed to list items' });
        }
    });

    // POST /v1/kv/bulk - Bulk get values
    app.post('/v1/kv/bulk', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                keys: z.array(z.string()).min(1).max(100)
            }),
            response: {
                200: z.object({
                    values: z.array(z.object({
                        key: z.string(),
                        value: z.string(),
                        version: z.number()
                    }))
                }),
                400: z.object({
                    error: z.literal('Invalid parameters')
                }),
                426: AccountStoredContentUpgradeRequiredV1Schema,
                500: z.object({
                    error: z.literal('Failed to get values')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { keys } = request.body;

        try {
            const result = await kvBulkGet({ uid: userId }, keys);
            await assertTodoKvReadStoredContentMatchesAccount(
                userId,
                result.values,
            );
            if (
                containsCurrentTodoStoredContent(result.values)
                && !readAccountStoredContentCompatibilityForHttpRequest(request)
                    .supportsCurrentProtocol
            ) {
                await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                    request,
                    reply,
                );
                return;
            }
            return reply.send(result);
        } catch (error) {
            if (error instanceof AccountScopedKvReservedKeyError) {
                return reply.code(400).send({ error: 'Invalid parameters' });
            }
            if (error instanceof TodoKvStoredContentModeMismatchError) {
                return reply.code(400).send({ error: 'Invalid parameters' });
            }
            log({ module: 'api', level: 'error' }, `Failed to bulk get KV values: ${error}`);
            return reply.code(500).send({ error: 'Failed to get values' });
        }
    });

    // PUT /v1/kv - Atomic batch mutation
    app.post('/v1/kv', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                mutations: z.array(z.object({
                    key: z.string(),
                    value: z.string().nullable(),
                    version: z.number()  // Always required, use -1 for new keys
                })).min(1).max(100)
            }),
            response: {
                200: z.object({
                    success: z.literal(true),
                    results: z.array(z.object({
                        key: z.string(),
                        version: z.number()
                    }))
                }),
                409: z.object({
                    success: z.literal(false),
                    errors: z.array(z.object({
                        key: z.string(),
                        error: z.literal('version-mismatch'),
                        version: z.number(),
                        value: z.string().nullable()
                    }))
                }),
                400: z.object({
                    error: z.literal('Invalid parameters')
                }),
                426: AccountStoredContentUpgradeRequiredV1Schema,
                500: z.object({
                    error: z.literal('Failed to mutate values')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { mutations } = request.body;

        try {
            const compatibility =
                readAccountStoredContentCompatibilityForHttpRequest(request);
            const result = await kvMutate(
                { uid: userId },
                mutations,
                {
                    supportsCurrentProtocol:
                        compatibility.supportsCurrentProtocol,
                },
            );

            if (!result.success) {
                return reply.code(409).send({
                    success: false as const,
                    errors: result.errors!
                });
            }

            return reply.send({
                success: true as const,
                results: result.results!
            });
        } catch (error) {
            if (error instanceof AccountScopedKvReservedKeyError) {
                return reply.code(400).send({ error: 'Invalid parameters' });
            }
            if (error instanceof TodoKvStoredContentUpgradeRequiredError) {
                await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                    request,
                    reply,
                );
                return;
            }
            if (error instanceof TodoKvStoredContentModeMismatchError) {
                return reply.code(400).send({ error: 'Invalid parameters' });
            }
            log({ module: 'api', level: 'error' }, `Failed to mutate KV values: ${error}`);
            return reply.code(500).send({ error: 'Failed to mutate values' });
        }
    });
}
