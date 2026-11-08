import { AccountStoredContentUpgradeRequiredV1Schema } from '@happier-dev/protocol/clientCompatibility/upgradeRequiredV1';
import * as privacyKit from "privacy-kit";
import { z } from "zod/mini";
import { isTransactionStorageError } from '@/storage/transactionErrors';
import { sendTransactionUnavailable } from '@/app/api/utils/sendTransactionUnavailable';
import { Fastify } from "../../types";
import { kvGet } from "@/app/kv/kvGet";
import { kvList } from "@/app/kv/kvList";
import { kvBulkGet } from "@/app/kv/kvBulkGet";
import { kvMutate, KvMutationRequestSchema } from "@/app/kv/kvMutate";
import {
    enforceCurrentAccountStoredContentCompatibilityForHttpRequest,
    readAccountStoredContentCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import {
    assertAccountJsonKvStoredContentMatchesAccountMode,
    classifyAccountJsonKvStoredContent,
    isAccountJsonKvKey,
    AccountJsonKvStoredContentModeMismatchError,
    AccountJsonKvStoredContentUpgradeRequiredError,
} from "@/app/kv/accountJsonKvStoredContent";
import {
    deriveAccountEncryptionCurrentnessFromRow,
} from "@/app/encryption/accountContentKeyAdmission";
import { AccountScopedKvReservedKeyError } from "@/app/kv/accountScopedKv";
import { db } from "@/storage/db";
import { log } from "@/utils/logging/log";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";

function containsCurrentAccountJsonKvStoredContent(
    items: ReadonlyArray<Readonly<{ key: string; value: string }>>,
): boolean {
    return items.some((item) => {
        if (!isAccountJsonKvKey(item.key)) {
            return false;
        }
        const classification = classifyAccountJsonKvStoredContent({
            key: item.key,
            value: privacyKit.decodeBase64(item.value),
        });
        return classification.domain !== "generic"
            && classification.representation.startsWith("current_");
    });
}

async function assertAccountJsonKvReadStoredContentMatchesAccount(
    accountId: string,
    items: ReadonlyArray<Readonly<{ key: string; value: string }>>,
): Promise<void> {
    const accountJsonItems = items.filter((item) => isAccountJsonKvKey(item.key));
    if (accountJsonItems.length === 0) return;

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
        throw new AccountJsonKvStoredContentModeMismatchError();
    }
    for (const item of accountJsonItems) {
        assertAccountJsonKvStoredContentMatchesAccountMode({
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
                200: z.nullable(z.object({
                    key: z.string(),
                    value: z.string(),
                    version: z.number()
                })),
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
            await assertAccountJsonKvReadStoredContentMatchesAccount(
                userId,
                [result],
            );
            if (
                containsCurrentAccountJsonKvStoredContent([result])
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
            if (error instanceof AccountJsonKvStoredContentModeMismatchError) {
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
                prefix: z.optional(z.string()),
                afterKey: z.optional(z.string()),
                limit: z._default(z.coerce.number().check(z.int(), z.minimum(1), z.maximum(1000)), 100)
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
        const { prefix, limit, afterKey } = request.query;

        try {
            const result = await kvList({ uid: userId }, { prefix, limit, afterKey });
            await assertAccountJsonKvReadStoredContentMatchesAccount(
                userId,
                result.items,
            );
            if (
                containsCurrentAccountJsonKvStoredContent(result.items)
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
            if (error instanceof AccountJsonKvStoredContentModeMismatchError) {
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
                keys: z.array(z.string()).check(z.minLength(1), z.maxLength(100))
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
            await assertAccountJsonKvReadStoredContentMatchesAccount(
                userId,
                result.values,
            );
            if (
                containsCurrentAccountJsonKvStoredContent(result.values)
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
            if (error instanceof AccountJsonKvStoredContentModeMismatchError) {
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
            body: KvMutationRequestSchema,
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
                        value: z.nullable(z.string())
                    }))
                }),
                400: z.object({
                    error: z.literal('Invalid parameters')
                }),
                426: AccountStoredContentUpgradeRequiredV1Schema,
                500: z.object({
                    error: z.literal('Failed to mutate values')
                }),
                503: z.object({
                    error: z.literal('transaction-unavailable'),
                    retryAfterMs: z.number(),
                }),
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
            if (error instanceof AccountJsonKvStoredContentUpgradeRequiredError) {
                await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                    request,
                    reply,
                );
                return;
            }
            if (error instanceof AccountJsonKvStoredContentModeMismatchError) {
                return reply.code(400).send({ error: 'Invalid parameters' });
            }
            if (isTransactionStorageError(error)) {
                return sendTransactionUnavailable(reply, { error: 'transaction-unavailable', retryAfterMs: 1_000 });
            }
            log({ module: 'api', level: 'error' }, `Failed to mutate KV values: ${error}`);
            return reply.code(500).send({ error: 'Failed to mutate values' });
        }
    });
}
