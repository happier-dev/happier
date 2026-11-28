import { z } from "zod";

const date = z.iso.datetime({ offset: true });
const purchase = z.object({
    purchase_date: date,
    store: z.string(),
    is_sandbox: z.boolean(),
    refunded_at: date.nullish(),
});
const responseSchema = z.object({
    subscriber: z.object({
        entitlements: z.record(z.string(), z.object({ product_identifier: z.string() })),
        subscriptions: z.record(z.string(), purchase.extend({
            expires_date: date.nullable(),
            grace_period_expires_date: date.nullish(),
            unsubscribe_detected_at: date.nullish(),
        })),
        non_subscriptions: z.record(z.string(), z.array(purchase)),
    }),
});

export type RevenueCatSubscriber = z.infer<typeof responseSchema>["subscriber"];
export type RevenueCatClient = Readonly<{ readSubscriber(ref: string): Promise<RevenueCatSubscriber | null> }>;
export class RevenueCatRequestError extends Error {}

export function readRevenueCatConfig(env: NodeJS.ProcessEnv) {
    const secret = env.REVENUECAT_SECRET_KEY?.trim();
    return secret ? { secret, webhookAuth: env.REVENUECAT_WEBHOOK_AUTH?.trim() || null } : null;
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
