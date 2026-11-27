import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod/mini";

import type { Fastify } from "@/app/api/types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";
import { registerSupporterDiscordLinks, registerSupporterGitHubStart } from "@/app/supporter/supporterLinks";
import { registerSupporterPerkRoutes } from "@/app/supporter/supporterPerks";
import { registerStarAskRoutes } from "@/app/supporter/starAsk";
import { log } from "@/utils/logging/log";

import { createPolarClient, PolarRequestError } from "./polarClient";
import { verifyPolarWebhookSignature } from "./polarWebhookSignature";
import { readBillingConfig } from "./readBillingConfig";
import { isBillingRef, reconcileBillingForRef } from "./reconcileBilling";
import { createRevenueCatClient, RevenueCatRequestError } from "./revenueCatClient";
import { registerSupporterRoutes } from "./registerSupporterRoutes";

const PolarWebhookEnvelopeSchema = z.object({
    type: z.string(),
    data: z.looseObject({ metadata: z.nullish(z.record(z.string(), z.unknown())) }),
});

const RevenueCatWebhookEnvelopeSchema = z.object({
    event: z.object({
        type: z.string(),
        app_user_id: z.optional(z.string()),
        transferred_from: z.optional(z.array(z.string())),
        transferred_to: z.optional(z.array(z.string())),
    }),
});

function isProviderError(error: unknown): error is PolarRequestError | RevenueCatRequestError {
    return error instanceof PolarRequestError || error instanceof RevenueCatRequestError;
}

function readHeader(value: string | string[] | undefined): string | undefined {
    return typeof value === "string" ? value : undefined;
}

/**
 * Provider routes follow the Home's configured billing services.
 */
export function billingRoutes(app: Fastify, deps: Readonly<{ env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }> = {}): void {
    const env = deps.env ?? process.env;
    const config = readBillingConfig(env);
    const polar = config.polar ? createPolarClient(config.polar, deps.fetchImpl) : null;
    const revenueCat = config.revenueCat ? createRevenueCatClient(config.revenueCat.secret, deps.fetchImpl) : null;
    registerStarAskRoutes(app, env);
    registerSupporterRoutes(app, { billingConfigured: config.billingReference === "account" });
    registerSupporterDiscordLinks(app, env);
    if (config.billingReference !== "account") return;
    registerSupporterPerkRoutes(app, env);
    registerSupporterGitHubStart(app, env);

    const reconcile: BillingReconcile = async (ref, request, transferFrom) =>
        await reconcileBillingForRef(ref, { polar, revenueCat, env: deps.env ?? await readRequestHomeEnv(request) }, transferFrom);

    if (config.polar?.webhookSecret) {
        registerPolarWebhookRoute(app as unknown as FastifyInstance, { secret: config.polar.webhookSecret, reconcile });
    }
    if (config.revenueCat?.webhookAuth) {
        registerRevenueCatWebhookRoute(app, config.revenueCat.webhookAuth, reconcile);
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
            if (isProviderError(error)) return reply.code(502).send({ error: "provider_unavailable" });
            throw error;
        }
        return reply.send({ ok: true });
    });
}

type BillingReconcile = (ref: string, request: object, transferFrom?: readonly string[]) => Promise<unknown>;

/** RevenueCat sends a configured Authorization header. Its events only identify records to re-read. */
function registerRevenueCatWebhookRoute(app: Fastify, authorization: string, reconcile: BillingReconcile): void {
    const expected = createHash("sha256").update(authorization).digest();
    app.post("/v1/billing/revenuecat", async (request, reply) => {
        const received = readHeader(request.headers.authorization);
        if (received === undefined || !timingSafeEqual(createHash("sha256").update(received).digest(), expected)) {
            return reply.code(403).send({ error: "invalid_signature" });
        }
        const parsed = RevenueCatWebhookEnvelopeSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: "invalid_payload" });
        const { type, app_user_id, transferred_from, transferred_to } = parsed.data.event;
        try {
            if (type === "TRANSFER") {
                const sources = transferred_from?.filter(isBillingRef) ?? [];
                const destinations = [...new Set(transferred_to?.filter(isBillingRef))];
                const [destination] = destinations;
                if (destination && destinations.length === 1) {
                    await reconcile(destination, request, sources);
                } else {
                    await Promise.all([...new Set([...sources, ...destinations])].map((ref) => reconcile(ref, request)));
                }
            } else if (type !== "TEST" && app_user_id) {
                await reconcile(app_user_id, request);
            }
        } catch (error) {
            if (!isProviderError(error)) throw error;
            log({ module: "billing", level: "warn" }, `RevenueCat webhook reconcile deferred: ${error.message}`);
            return reply.code(502).send({ error: "provider_unavailable" });
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
    reconcile: BillingReconcile;
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
                if (isProviderError(error)) {
                    log({ module: "billing", level: "warn" }, `Polar webhook reconcile deferred: ${error.message}`);
                    return reply.code(502).send({ error: "provider_unavailable" });
                }
                throw error;
            }
            return reply.code(200).send({ ok: true });
        });
    });
}
