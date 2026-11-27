import type { FastifyInstance } from "fastify";
import { z } from "zod/mini";

import type { Fastify } from "@/app/api/types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";
import { log } from "@/utils/logging/log";

import { createPolarClient, PolarRequestError, readPolarConfig } from "./polarClient";
import { verifyPolarWebhookSignature } from "./polarWebhookSignature";
import { reconcileBillingForRef } from "./reconcileBilling";
import { registerSupporterRoutes } from "./registerSupporterRoutes";

const PolarWebhookEnvelopeSchema = z.object({
    type: z.string(),
    data: z.looseObject({ metadata: z.nullish(z.record(z.string(), z.unknown())) }),
});

function readHeader(value: string | string[] | undefined): string | undefined {
    return typeof value === "string" ? value : undefined;
}

/**
 * Billing composition root. Every billing route exists only where billing is configured (Polar
 * server token present); a self-hosted server registers the session-scoped supporter routes only.
 * Removing this folder and its registration leaves a server that boots and serves everything else.
 */
export function billingRoutes(app: Fastify, deps: Readonly<{ env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }> = {}): void {
    const env = deps.env ?? process.env;
    const config = readPolarConfig(env);
    const polar = config ? createPolarClient(config, deps.fetchImpl) : null;
    registerSupporterRoutes(app, { billingConfigured: polar !== null });
    if (!config || !polar) return;

    const reconcile = async (ref: string, request: object) =>
        await reconcileBillingForRef(ref, { polar, env: deps.env ?? await readRequestHomeEnv(request) });

    if (config.webhookSecret) {
        registerPolarWebhookRoute(app as unknown as FastifyInstance, { secret: config.webhookSecret, reconcile });
    }

    // Check again on Cloud: the read-your-own-write after a purchase, and the only repair control.
    app.post("/v1/billing/refresh", {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(env, "billing.refresh") },
        schema: {
            response: {
                200: z.object({ ok: z.literal(true) }),
                502: z.object({ error: z.literal("provider_unavailable") }),
            },
        },
    }, async (request, reply) => {
        try {
            await reconcile(request.userId, request);
        } catch (error) {
            if (error instanceof PolarRequestError) return reply.code(502).send({ error: "provider_unavailable" });
            throw error;
        }
        return reply.send({ ok: true });
    });
}

/**
 * `POST /v1/billing/polar`. Unauthenticated apart from the Standard Webhooks signature, which is
 * computed over the exact bytes Polar sent, so this route alone parses its body as a raw string
 * (an encapsulated Fastify scope; every other route keeps the JSON parser). The event only names
 * the `ref`; state comes from re-reading Polar. A failed read answers 502 so Polar redelivers.
 */
function registerPolarWebhookRoute(app: FastifyInstance, deps: Readonly<{
    secret: string;
    reconcile: (ref: string, request: object) => Promise<unknown>;
}>): void {
    app.register(async (scope) => {
        scope.removeContentTypeParser("application/json");
        scope.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => done(null, body));

        scope.post("/v1/billing/polar", async (request, reply) => {
            const rawBody = typeof request.body === "string" ? request.body : "";
            const verified = verifyPolarWebhookSignature({
                secret: deps.secret,
                rawBody,
                webhookId: readHeader(request.headers["webhook-id"]),
                webhookTimestamp: readHeader(request.headers["webhook-timestamp"]),
                webhookSignature: readHeader(request.headers["webhook-signature"]),
            });
            if (!verified) return reply.code(403).send({ error: "invalid_signature" });

            let envelope: z.infer<typeof PolarWebhookEnvelopeSchema>;
            try {
                envelope = PolarWebhookEnvelopeSchema.parse(JSON.parse(rawBody));
            } catch {
                return reply.code(400).send({ error: "invalid_payload" });
            }
            const ref = envelope.data.metadata?.reference_id;
            const relevant = envelope.type.startsWith("subscription.") || envelope.type.startsWith("order.");
            if (!relevant || typeof ref !== "string") return reply.code(202).send({ ok: true });

            try {
                await deps.reconcile(ref, request);
            } catch (error) {
                if (error instanceof PolarRequestError) {
                    log({ module: "billing", level: "warn" }, `Polar webhook reconcile deferred: ${error.message}`);
                    return reply.code(502).send({ error: "provider_unavailable" });
                }
                throw error;
            }
            return reply.code(200).send({ ok: true });
        });
    });
}
