import { readServerConfig } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import { z } from "zod/mini";

import { BILLING_SERVER_CONFIG } from './billingServerConfig';

/** Polar answers webhooks within 10 s; a provider read must never hold a delivery past that. */
const POLAR_READ_TIMEOUT_MS = 10_000;
/** Polar's documented page-size maximum for list endpoints. */
const POLAR_PAGE_LIMIT = 100;
// Unit pricing is only part of Polar's 2026-10 API.
const POLAR_UNIT_API_VERSION = "2026-10";

export type PolarConfig = Readonly<{
    accessToken: string;
    webhookSecret: string | null;
    baseUrl: string;
}>;

/**
 * Billing is configured on this server when a Polar server token is present (Happier Cloud).
 * Absent env is the off switch: no billing route is registered and nothing calls out.
 */
export function readPolarConfig(env: NodeJS.ProcessEnv): PolarConfig | null {
    const accessToken = readServerConfig(env, BILLING_SERVER_CONFIG.POLAR_ACCESS_TOKEN);
    if (!accessToken) return null;
    const webhookSecret = readServerConfig(env, BILLING_SERVER_CONFIG.POLAR_WEBHOOK_SECRET) ?? null;
    const baseUrl = readServerConfig(env, BILLING_SERVER_CONFIG.POLAR_SERVER) === "sandbox" ? "https://sandbox-api.polar.sh" : "https://api.polar.sh";
    return { accessToken, webhookSecret, baseUrl };
}

/** A provider read that did not complete. Callers write nothing and answer non-2xx. */
export class PolarRequestError extends Error {
    readonly status: number | null;

    constructor(message: string, status: number | null) {
        super(message);
        this.name = "PolarRequestError";
        this.status = status;
    }
}

const MetadataSchema = z.nullish(z.record(z.string(), z.unknown()));
const ProductMetadataSchema = z.nullish(z.object({ metadata: MetadataSchema }));

const PolarSubscriptionSchema = z.object({
    id: z.string(),
    status: z.string(),
    current_period_end: z.nullish(z.string()),
    cancel_at_period_end: z.nullish(z.boolean()),
    started_at: z.nullish(z.string()),
    ended_at: z.nullish(z.string()),
    metadata: MetadataSchema,
    product: ProductMetadataSchema,
});
export type PolarSubscription = z.infer<typeof PolarSubscriptionSchema>;

const PolarUnitSubscriptionSchema = z.object({
    ...PolarSubscriptionSchema.shape,
    product_id: z.string(),
    units: z.nullish(z.int().check(z.minimum(1))),
});
export type PolarUnitSubscription = z.infer<typeof PolarUnitSubscriptionSchema>;
const PolarCheckoutSchema = z.object({ url: z.url({ protocol: /^https$/ }) });
const PolarUnitChangeSchema = z.object({ units: z.int().check(z.minimum(1)) });

const PolarOrderSchema = z.object({
    id: z.string(),
    status: z.string(),
    created_at: z.string(),
    subscription_id: z.nullish(z.string()),
    billing_reason: z.nullish(z.string()),
    metadata: MetadataSchema,
    product: ProductMetadataSchema,
});
export type PolarOrder = z.infer<typeof PolarOrderSchema>;

function listPageSchema<T extends z.ZodMiniType>(item: T) {
    return z.object({
        items: z.array(item),
        pagination: z.object({ total_count: z.number(), max_page: z.number() }),
    });
}

export type PolarClient = Readonly<{
    listSubscriptionsForRef(ref: string): Promise<PolarSubscription[]>;
    listOrdersForRef(ref: string): Promise<PolarOrder[]>;
}>;

export type PolarTeamClient = Readonly<{
    listSubscriptionsForTeam(teamId: string): Promise<PolarUnitSubscription[]>;
    createTeamCheckout(input: Readonly<{ teamId: string; productId: string; units: number; customerIp: string }>): Promise<{ url: string }>;
    changeTeamSubscriptionUnits(subscriptionId: string, units: number): Promise<{ units: number }>;
}>;

export function createPolarClient(config: PolarConfig, fetchImpl: typeof fetch = fetch): PolarClient & PolarTeamClient {
    async function request(path: string, options: Readonly<{
        version?: string;
        method?: "POST" | "PATCH";
        body?: object;
    }> = {}): Promise<unknown> {
        let response: Response;
        let body: unknown;
        try {
            response = await fetchImpl(`${config.baseUrl}${path}`, {
                method: options.method,
                headers: {
                    authorization: `Bearer ${config.accessToken}`,
                    accept: "application/json",
                    ...(options.version ? { "Polar-Version": options.version } : {}),
                    ...(options.body ? { "content-type": "application/json" } : {}),
                },
                body: options.body ? JSON.stringify(options.body) : undefined,
                signal: AbortSignal.timeout(POLAR_READ_TIMEOUT_MS),
            });
            body = await response.json();
        } catch (error) {
            const name = error instanceof Error ? error.name : "Error";
            throw new PolarRequestError(`Polar request failed (${name})`, null);
        }
        if (!response.ok) throw new PolarRequestError(`Polar answered ${response.status}`, response.status);
        return body;
    }

    async function listAll<T extends z.ZodMiniType>(
        path: string, metadataKey: "reference_id" | "team_id", ref: string, item: T, version?: string,
    ): Promise<z.infer<T>[]> {
        const pageSchema = listPageSchema(item);
        const items: z.infer<T>[] = [];
        for (let page = 1; ; page++) {
            const query = new URLSearchParams({ [`metadata[${metadataKey}]`]: ref, limit: String(POLAR_PAGE_LIMIT), page: String(page) });
            const parsed = pageSchema.safeParse(await request(`${path}?${query.toString()}`, { version }));
            if (!parsed.success) throw new PolarRequestError(`Polar ${path} response did not match the expected shape`, null);
            items.push(...parsed.data.items);
            if (page >= parsed.data.pagination.max_page) return items;
        }
    }

    return {
        listSubscriptionsForRef: async (ref) => await listAll("/v1/subscriptions/", "reference_id", ref, PolarSubscriptionSchema),
        listOrdersForRef: async (ref) => await listAll("/v1/orders/", "reference_id", ref, PolarOrderSchema),
        listSubscriptionsForTeam: async (teamId) => await listAll(
            "/v1/subscriptions/", "team_id", teamId, PolarUnitSubscriptionSchema, POLAR_UNIT_API_VERSION,
        ),
        async createTeamCheckout({ teamId, productId, units, customerIp }) {
            const parsed = PolarCheckoutSchema.safeParse(await request("/v1/checkouts/", {
                version: POLAR_UNIT_API_VERSION, method: "POST",
                body: { products: [productId], units, metadata: { team_id: teamId }, customer_ip_address: customerIp },
            }));
            if (!parsed.success) throw new PolarRequestError("Invalid Polar Team checkout response", null);
            return parsed.data;
        },
        async changeTeamSubscriptionUnits(subscriptionId, units) {
            const parsed = PolarUnitChangeSchema.safeParse(await request(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
                version: POLAR_UNIT_API_VERSION, method: "PATCH", body: { units },
            }));
            if (!parsed.success) throw new PolarRequestError("Invalid Polar Team units response", null);
            return parsed.data;
        },
    };
}
