import { StoredJsonContentEnvelopeSchema } from "@happier-dev/protocol";
import { z } from "zod";
import type { FastifyReply } from "fastify";

import type { Fastify } from "../../../types";
import { resolveApiHotEndpointRateLimit } from "../../../utils/apiRateLimitCatalog";

import {
    createConnectedAccountAttemptTransaction,
    deleteConnectedAccountAttemptTransaction,
    readConnectedAccountAttemptTransaction,
    replaceConnectedAccountAttemptTransaction,
} from "./connectedAccountAttemptTransactionStore";

const MAX_TRANSACTION_LIFETIME_MS = 24 * 60 * 60_000;

const TransactionParamsSchema = z.object({
    kind: z.enum(["oauth", "device"]),
    attemptId: z.string()
        .min(1)
        .max(160)
        .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
}).strict();

const MAX_TRANSACTION_CONTENT_UTF8_BYTES = 524_288;

/**
 * One explicit Account stored-content envelope, bounded by its serialized size. The
 * kind is never inferred: a plain Account sends `{ t: 'plain', v }` and an E2EE
 * Account `{ t: 'encrypted', c }`, and the store admits it against the persisted
 * Account mode.
 */
const TransactionEnvelopeSchema = StoredJsonContentEnvelopeSchema
    .superRefine((value, context) => {
        if (
            new TextEncoder().encode(JSON.stringify(value)).byteLength
            > MAX_TRANSACTION_CONTENT_UTF8_BYTES
        ) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Connected-account attempt transaction content exceeds its byte limit",
            });
        }
    });

const TransactionContentSchema = z.object({
    content: TransactionEnvelopeSchema,
    expiresAtMs: z.number().int().positive(),
}).strict();

const TransactionMutationSchema = TransactionContentSchema.extend({
    expectedRevision: z.number().int().min(1),
}).strict();

const TransactionDeleteSchema = z.object({
    expectedRevision: z.number().int().min(1),
}).strict();

const TransactionRecordSchema = z.object({
    revision: z.number().int().min(1),
    content: TransactionEnvelopeSchema,
    expiresAtMs: z.number().int().positive(),
}).strict();

const TransactionErrorSchema = z.object({
    error: z.enum([
        "connected_account_attempt_transaction_not_found",
        "connected_account_attempt_transaction_conflict",
        "connected_account_attempt_transaction_expiry_invalid",
        "connected_account_attempt_transaction_storage_mode_mismatch",
        "connected_account_attempt_transaction_unreadable",
    ]),
}).strict();

function expiryIsValid(expiresAtMs: number, nowMs: number): boolean {
    return expiresAtMs > nowMs
        && expiresAtMs - nowMs <= MAX_TRANSACTION_LIFETIME_MS;
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
            body: TransactionContentSchema,
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
        const result = await createConnectedAccountAttemptTransaction({
            accountId: request.userId,
            ...request.params,
            ...request.body,
        });
        if (result.status !== "ok") {
            return sendMutationError(reply, result.status);
        }
        return reply.send(result.record);
    });

    app.get("/v2/connect/connected-account-attempt-transactions/:kind/:attemptId", {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(
                process.env,
                "connectedServices.deviceAuth.poll",
            ),
        },
        schema: {
            params: paramsSchema,
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
                200: z.object({ status: z.literal("deleted") }).strict(),
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
