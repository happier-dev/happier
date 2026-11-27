import { SERVER_CONFIG } from "@happier-dev/protocol/serverConfig/registry";
import { readServerConfig } from "@happier-dev/protocol/serverConfig/serverConfigCodec";
import { z } from "zod/mini";

import { BILLING_SERVER_CONFIG } from "./billingServerConfig";

const date = z.iso.datetime({ offset: true });
const purchase = z.object({
    purchase_date: date,
    store: z.string(),
    is_sandbox: z.boolean(),
    refunded_at: z.nullish(date),
});
const responseSchema = z.object({
    subscriber: z.object({
        entitlements: z.record(z.string(), z.object({ product_identifier: z.string() })),
        subscriptions: z.record(z.string(), z.extend(purchase, {
            expires_date: z.nullable(date),
            grace_period_expires_date: z.nullish(date),
            unsubscribe_detected_at: z.nullish(date),
        })),
        non_subscriptions: z.record(z.string(), z.array(purchase)),
    }),
});

export type RevenueCatSubscriber = z.infer<typeof responseSchema>["subscriber"];
export type RevenueCatClient = Readonly<{ readSubscriber(ref: string): Promise<RevenueCatSubscriber | null> }>;
export class RevenueCatRequestError extends Error {
    override name = "RevenueCatRequestError";
}

export function readRevenueCatConfig(env: NodeJS.ProcessEnv) {
    const secret = readServerConfig(env, SERVER_CONFIG.REVENUECAT_SECRET_KEY);
    return secret ? { secret, webhookAuth: readServerConfig(env, BILLING_SERVER_CONFIG.REVENUECAT_WEBHOOK_AUTH) ?? null } : null;
}

/** A missing subscriber is empty. Every other failure must stop reconciliation. */
export function createRevenueCatClient(secret: string, fetchImpl: typeof fetch = fetch): RevenueCatClient {
    return {
        async readSubscriber(ref) {
            try {
                const result = await fetchImpl(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(ref)}`, {
                    headers: { authorization: `Bearer ${secret}`, accept: "application/json" },
                    signal: AbortSignal.timeout(10_000),
                });
                if (result.status === 404) return null;
                if (!result.ok) throw new RevenueCatRequestError(`RevenueCat answered ${result.status}`);
                return responseSchema.parse(await result.json()).subscriber;
            } catch (error) {
                if (error instanceof RevenueCatRequestError) throw error;
                throw new RevenueCatRequestError("RevenueCat subscriber read failed");
            }
        },
    };
}
