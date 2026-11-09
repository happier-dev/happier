import { CONNECTED_ACCOUNT_ATTEMPT_TRANSACTION_LIFETIME_MS } from '@happier-dev/cli-common/connectedAccounts';
import { StoredJsonContentEnvelopeSchema } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import { z } from "zod/mini";
import type { FastifyReply } from "fastify";

import type { Fastify } from "../../../types";
import { resolveApiHotEndpointRateLimit } from "../../../utils/apiRateLimitCatalog";

import {
    createConnectedAccountAttemptTransaction,
    deleteConnectedAccountAttemptTransaction,
    listPendingConnectedAccountAttemptTransactions,
    readConnectedAccountAttemptTransaction,
    replaceConnectedAccountAttemptTransaction,
} from "./connectedAccountAttemptTransactionStore";

const TransactionParamsSchema = z.strictObject({
    kind: z.enum(["manual", "oauth", "device"]),
    attemptId: z.string().check(z.minLength(1), z.maxLength(160), z.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)),
});

/**
 * One explicit Account stored-content envelope. The API server owns the request-body
 * transport boundary; attempts add no smaller content ceiling. The
 * kind is never inferred: a plain Account sends `{ t: 'plain', v }` and an E2EE
 * Account `{ t: 'encrypted', c }`, and the store admits it against the persisted
 * Account mode.
 */
const TransactionEnvelopeSchema = StoredJsonContentEnvelopeSchema;

const TransactionScopeSchema = z.strictObject({
    machineId: z.optional(z.string().check(z.minLength(1), z.maxLength(256))),
    service: z.strictObject({
        pluginId: z.string().check(z.minLength(1), z.maxLength(256)),
        localId: z.string().check(z.minLength(1), z.maxLength(256)),
    }),
    modeId: z.string().check(z.minLength(1), z.maxLength(256)),
    intent: z.enum(["connect", "reconnect"]),
    phase: z.enum(["starting", "configurationRequired", "awaitingManual", "awaitingOAuth", "awaitingDeviceAuthorization", "outcomeUnknown"]),
    createdAtMs: z.number().check(z.int(), z.nonnegative()),
});

const TransactionContentSchema = z.strictObject({
    content: TransactionEnvelopeSchema,
    expiresAtMs: z.number().check(z.int(), z.positive()),
    scope: TransactionScopeSchema,
});

const TransactionCreateSchema = z.strictObject({
    ...TransactionContentSchema.shape,
    expiresAtMs: z.optional(TransactionContentSchema.shape.expiresAtMs),
});

const TransactionMutationSchema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(TransactionContentSchema, {
    expectedRevision: z.number().check(z.int(), z.minimum(1)),
}));

const TransactionDeleteSchema = z.strictObject({
    expectedRevision: z.number().check(z.int(), z.minimum(1)),
});

const TransactionRecordSchema = z.strictObject({
    kind: TransactionParamsSchema.shape.kind,
    revision: z.number().check(z.int(), z.minimum(1)),
    content: TransactionEnvelopeSchema,
    expiresAtMs: z.number().check(z.int(), z.positive()),
    scope: TransactionScopeSchema,
});

const TransactionErrorSchema = z.strictObject({
    error: z.enum([
        "connected_account_attempt_transaction_not_found",
        "connected_account_attempt_transaction_conflict",
        "connected_account_attempt_transaction_expiry_invalid",
        "connected_account_attempt_transaction_storage_mode_mismatch",
        "connected_account_attempt_transaction_unreadable",
    ]),
});

function expiryIsValid(expiresAtMs: number, nowMs: number): boolean {
    return expiresAtMs > nowMs
        && expiresAtMs - nowMs <= CONNECTED_ACCOUNT_ATTEMPT_TRANSACTION_LIFETIME_MS;
}

function sendMutationError(
    reply: FastifyReply,
    status:
        | "not_found"
        | "conflict"
        | "storage_mode_mismatch"
        | "unreadable",
): FastifyReply {
    if (status === "not_found") {
        return reply.code(404).send({
            error: "connected_account_attempt_transaction_not_found",
        });
    }
    // A representation that disagrees with the persisted Account mode is an
    // inconsistent write, not a lost race: it is refused without storing anything.
    return reply.code(409).send({
        error: status === "storage_mode_mismatch"
            ? "connected_account_attempt_transaction_storage_mode_mismatch"
            : status === "unreadable"
                ? "connected_account_attempt_transaction_unreadable"
                : "connected_account_attempt_transaction_conflict",
    });
}

export function registerConnectedAccountAttemptTransactionRoutes(
    app: Fastify,
): void {
    const paramsSchema = TransactionParamsSchema;
    const errorResponses = {
        404: TransactionErrorSchema,
        409: TransactionErrorSchema,
    };

    app.get("/v2/connect/connected-account-attempt-transactions/pending", {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(
                process.env,
                "connectedServices.deviceAuth.poll",
            ),
        },
        schema: {
            querystring: z.strictObject({
                machineId: z.optional(z.string().check(z.minLength(1), z.maxLength(256))),
                pluginId: z.string().check(z.minLength(1), z.maxLength(256)),
                localId: z.string().check(z.minLength(1), z.maxLength(256)),
            }),
            response: {
                200: z.strictObject({
                    attempts: z.array(z.strictObject({
                        attemptId: TransactionParamsSchema.shape.attemptId,
                        kind: TransactionParamsSchema.shape.kind,
                        modeId: z.string().check(z.minLength(1), z.maxLength(256)),
                        intent: z.enum(["connect", "reconnect"]),
                        phase: TransactionScopeSchema.shape.phase,
                        createdAtMs: z.number().check(z.int(), z.nonnegative()),
                        expiresAtMs: z.number().check(z.int(), z.positive()),
                    })),
                }),
                409: TransactionErrorSchema,
            },
        },
    }, async (request, reply) => {
        const result = await listPendingConnectedAccountAttemptTransactions({
            accountId: request.userId,
            machineId: request.query.machineId,
            service: {
                pluginId: request.query.pluginId,
                localId: request.query.localId,
            },
            nowMs: Date.now(),
        });
        if (result.status !== "ok") return sendMutationError(reply, result.status);
        return reply.send({ attempts: [...result.attempts] });
    });

    app.post("/v2/connect/connected-account-attempt-transactions/:kind/:attemptId", {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(
                process.env,
                "connectedServices.deviceAuth.start",
            ),
        },
        schema: {
            params: paramsSchema,
            body: TransactionCreateSchema,
            response: {
                200: TransactionRecordSchema,
                ...errorResponses,
            },
        },
    }, async (request, reply) => {
        const nowMs = Date.now();
        const expiresAtMs = request.body.expiresAtMs
            ?? nowMs + CONNECTED_ACCOUNT_ATTEMPT_TRANSACTION_LIFETIME_MS;
        if (!expiryIsValid(expiresAtMs, nowMs)) {
            return reply.code(409).send({
                error: "connected_account_attempt_transaction_expiry_invalid",
            });
        }
        const result = await createConnectedAccountAttemptTransaction({
            accountId: request.userId,
            ...request.params,
            ...request.body,
            expiresAtMs,
        });
        if (result.status !== "ok") {
            return sendMutationError(reply, result.status);
        }
        return reply.send(result.record);
    });

    app.get("/v2/connect/connected-account-attempt-transactions/:attemptId", {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(
                process.env,
                "connectedServices.deviceAuth.poll",
            ),
        },
        schema: {
            params: z.strictObject({ attemptId: TransactionParamsSchema.shape.attemptId }),
            response: {
                200: TransactionRecordSchema,
                404: TransactionErrorSchema,
                409: TransactionErrorSchema,
            },
        },
    }, async (request, reply) => {
        const result = await readConnectedAccountAttemptTransaction({
            accountId: request.userId,
            ...request.params,
            nowMs: Date.now(),
        });
        if (result.status !== "ok") {
            return sendMutationError(reply, result.status);
        }
        return reply.send(result.record);
    });

    app.patch("/v2/connect/connected-account-attempt-transactions/:kind/:attemptId", {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(
                process.env,
                "connectedServices.deviceAuth.poll",
            ),
        },
        schema: {
            params: paramsSchema,
            body: TransactionMutationSchema,
            response: {
                200: TransactionRecordSchema,
                ...errorResponses,
            },
        },
    }, async (request, reply) => {
        const nowMs = Date.now();
        if (!expiryIsValid(request.body.expiresAtMs, nowMs)) {
            return reply.code(409).send({
                error: "connected_account_attempt_transaction_expiry_invalid",
            });
        }
        const result = await replaceConnectedAccountAttemptTransaction({
            accountId: request.userId,
            ...request.params,
            ...request.body,
            nowMs,
        });
        if (result.status !== "ok") {
            return sendMutationError(reply, result.status);
        }
        return reply.send(result.record);
    });

    app.delete("/v2/connect/connected-account-attempt-transactions/:kind/:attemptId", {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(
                process.env,
                "connectedServices.deviceAuth.start",
            ),
        },
        schema: {
            params: paramsSchema,
            body: TransactionDeleteSchema,
            response: {
                200: z.strictObject({ status: z.literal("deleted") }),
                ...errorResponses,
            },
        },
    }, async (request, reply) => {
        const result = await deleteConnectedAccountAttemptTransaction({
            accountId: request.userId,
            ...request.params,
            expectedRevision: request.body.expectedRevision,
            nowMs: Date.now(),
        });
        if (result.status !== "deleted") {
            return sendMutationError(reply, result.status);
        }
        return reply.send({ status: "deleted" });
    });
}
