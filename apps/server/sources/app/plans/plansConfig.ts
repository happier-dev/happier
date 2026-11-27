import { PlansConfigV1Schema, type PlansConfigV1, type SupporterOfferV1 } from "@happier-dev/protocol";

import { readPlansFeatureEnv } from "@/app/features/catalog/readFeatureEnv";

export type PlansConfigRead =
    | Readonly<{ ok: true; config: PlansConfigV1 | null }>
    | Readonly<{ ok: false; error: string }>;

/**
 * Public Supporter offer used when the operator has not configured one, so a plain self-hosted
 * server can still show Supporter (with the `supporter` bit on). These are public values, not a
 * limit. Amounts are minor units (USD cents).
 */
export function defaultSupporterOffer(): SupporterOfferV1 {
    return {
        suggestedMonthlyMinor: 500,
        minimumMinor: 300,
        currency: "usd",
        presets: { monthly: [300, 500, 1000, 2500], once: [1000, 2500, 5000, 10000] },
        // Happier Cloud's public Polar links are not created yet (owner procedure, plan 03 Polar step 2).
        checkoutUrls: { monthly: null, once: null },
    };
}

/**
 * The only reader of `HAPPIER_PLANS__CONFIG`.
 *
 * Unset is a valid "nothing to offer" server. Set but malformed is an error the callers surface:
 * the retention rules stop and the `plans` bit turns off, so an operator typo can never put paying
 * people on the deletion clock.
 */
export function readPlansConfig(env: NodeJS.ProcessEnv): PlansConfigRead {
    const raw = readPlansFeatureEnv(env).plansConfigRaw;
    if (raw === null) return { ok: true, config: null };
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch {
        return { ok: false, error: "HAPPIER_PLANS__CONFIG is not valid JSON" };
    }
    const parsed = PlansConfigV1Schema.safeParse(json);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue?.path.length ? issue.path.join(".") : "(root)";
        return { ok: false, error: `HAPPIER_PLANS__CONFIG is invalid at ${where}: ${issue?.message ?? "unknown"}` };
    }
    return { ok: true, config: parsed.data };
}
