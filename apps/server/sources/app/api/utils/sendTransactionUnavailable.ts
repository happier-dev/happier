import type { FastifyReply } from 'fastify';

/** Project the transaction owner's busy result without starting another attempt. */
export function sendTransactionUnavailable(
    reply: FastifyReply,
    result: Readonly<{ error: 'transaction-unavailable'; retryAfterMs: number; correlationId?: string }>,
) {
    reply.header('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1_000))));
    return reply.code(503).send({
        error: result.error,
        retryAfterMs: result.retryAfterMs,
        ...(result.correlationId ? { correlationId: result.correlationId } : {}),
    });
}
