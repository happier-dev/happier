import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Fastify } from "@/app/api/types";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { registerStarAskRoutes } from "@/app/supporter/starAsk";
import { registerSupporterDiscordLinks } from "@/app/supporter/supporterDiscord";
import { registerSupporterGitHubStart } from "@/app/supporter/supporterLinks";
import { registerSupporterPerkRoutes } from "@/app/supporter/supporterPerks";
import { log } from "@/utils/logging/log";

import { createPolarClient, PolarRequestError, readPolarConfig } from "./polarClient";
import { verifyPolarWebhookSignature } from "./polarWebhookSignature";
import { isBillingRef, reconcileBillingForRef } from "./reconcileBilling";
import { createRevenueCatClient, readRevenueCatConfig, RevenueCatRequestError } from "./revenueCatClient";
import { registerSupporterRoutes } from "./registerSupporterRoutes";

const PolarWebhookEnvelopeSchema = z.object({
    type: z.string(),
    data: z.object({ metadata: z.record(z.string(), z.unknown()).nullish() }).passthrough(),
});

const revenueCatEvent = z.object({
    event: z.object({
        type: z.string(),
        app_user_id: z.string().optional(),
        transferred_from: z.array(z.string()).optional(),
        transferred_to: z.array(z.string()).optional(),
    }),
});

function sameAuthorization(received: string | undefined, expected: string): boolean {
    const digest = (value: string) => createHash("sha256").update(value).digest();
    return received !== undefined && timingSafeEqual(digest(received), digest(expected));
}

function isProviderError(error: unknown): error is PolarRequestError | RevenueCatRequestError {
    return error instanceof PolarRequestError || error instanceof RevenueCatRequestError;
}

function readHeader(value: string | string[] | undefined): string | undefined {
    return typeof value === "string" ? value : undefined;
}

/**
 * Billing routes require provider configuration. Discord Linked Roles also requires its own OAuth config.
 * Removing this folder and its registration leaves a server that boots and serves everything else.
 */
export function billingRoutes(app: Fastify, deps: Readonly<{ env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }> = {}): void {
    const env = deps.env ?? process.env;
    const config = readPolarConfig(env);
    const polar = config ? createPolarClient(config, deps.fetchImpl) : null;
    const revenueCatConfig = readRevenueCatConfig(env);
    const revenueCat = revenueCatConfig ? createRevenueCatClient(revenueCatConfig.secret, deps.fetchImpl) : null;
    registerStarAskRoutes(app, env);
    registerSupporterRoutes(app, { billingConfigured: polar !== null || revenueCat !== null });
    if (!polar && !revenueCat) return;
    registerSupporterDiscordLinks(app, env, deps.fetchImpl);
    registerSupporterPerkRoutes(app, env);
    registerSupporterGitHubStart(app, env);

    const reconcile = async (ref: string, transferFrom?: readonly string[]) =>
        await reconcileBillingForRef(ref, { polar, revenueCat, env }, transferFrom);

    if (config?.webhookSecret) {
        registerPolarWebhookRoute(app as unknown as FastifyInstance, { secret: config.webhookSecret, reconcile });
    }
    const webhookAuth = revenueCatConfig?.webhookAuth;
    if (webhookAuth) {
        app.post("/v1/billing/revenuecat", async (request, reply) => {
            if (!sameAuthorization(readHeader(request.headers.authorization), webhookAuth)) {
                return reply.code(403).send({ error: "invalid_signature" });
            }
            const parsed = revenueCatEvent.safeParse(request.body);
            if (!parsed.success) return reply.code(400).send({ error: "invalid_payload" });
            const { type, app_user_id, transferred_from, transferred_to } = parsed.data.event;
            const sources = transferred_from?.filter(isBillingRef) ?? [];
            const destinations = [...new Set(transferred_to?.filter(isBillingRef) ?? [])];
            try {
                if (type === "TRANSFER") {
                    if (destinations.length === 1) await reconcile(destinations[0], sources);
                    else await Promise.all([...new Set([...sources, ...destinations])].map((id) => reconcile(id)));
                } else if (type !== "TEST" && app_user_id) {
                    await reconcile(app_user_id);
                }
            } catch (error) {
                if (!isProviderError(error)) throw error;
                log({ module: "billing", level: "warn" }, `RevenueCat webhook reconcile deferred: ${error.message}`);
                return reply.code(502).send({ error: "provider_unavailable" });
            }
            return reply.code(200).send({ ok: true });
        });
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
            await reconcile(request.userId);
        } catch (error) {
            if (isProviderError(error)) return reply.code(502).send({ error: "provider_unavailable" });
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
    reconcile: (ref: string) => Promise<unknown>;
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
                await deps.reconcile(ref);
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
