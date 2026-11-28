import { z } from "zod";

/** Polar answers webhooks within 10 s; a provider read must never hold a delivery past that. */
const POLAR_READ_TIMEOUT_MS = 10_000;
/** Polar's documented page-size maximum for list endpoints. */
const POLAR_PAGE_LIMIT = 100;

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
    const accessToken = env.POLAR_ACCESS_TOKEN?.trim();
    if (!accessToken) return null;
    const webhookSecret = env.POLAR_WEBHOOK_SECRET?.trim() || null;
    const baseUrl = env.POLAR_SERVER?.trim().toLowerCase() === "sandbox" ? "https://sandbox-api.polar.sh" : "https://api.polar.sh";
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

const ProductMetadataSchema = z.object({ metadata: z.record(z.string(), z.unknown()).nullish() }).nullish();
const MetadataSchema = z.record(z.string(), z.unknown()).nullish();

const PolarSubscriptionSchema = z.object({
    id: z.string(),
    status: z.string(),
    current_period_end: z.string().nullish(),
    cancel_at_period_end: z.boolean().nullish(),
    started_at: z.string().nullish(),
    ended_at: z.string().nullish(),
    metadata: MetadataSchema,
    product: ProductMetadataSchema,
});
export type PolarSubscription = z.infer<typeof PolarSubscriptionSchema>;

const PolarOrderSchema = z.object({
    id: z.string(),
    status: z.string(),
    created_at: z.string(),
    subscription_id: z.string().nullish(),
    billing_reason: z.string().nullish(),
    metadata: MetadataSchema,
    product: ProductMetadataSchema,
});
export type PolarOrder = z.infer<typeof PolarOrderSchema>;

function listPageSchema<T extends z.ZodType>(item: T) {
    return z.object({
        items: z.array(item),
        pagination: z.object({ total_count: z.number(), max_page: z.number() }),
    });
}

export type PolarClient = Readonly<{
    listSubscriptionsForRef(ref: string): Promise<PolarSubscription[]>;
    listOrdersForRef(ref: string): Promise<PolarOrder[]>;
}>;

export function createPolarClient(config: PolarConfig, fetchImpl: typeof fetch = fetch): PolarClient {
    async function request(path: string): Promise<unknown> {
        let response: Response;
        let body: unknown;
        try {
            response = await fetchImpl(`${config.baseUrl}${path}`, {
                headers: {
                    authorization: `Bearer ${config.accessToken}`,
                    accept: "application/json",
                },
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

    async function listAll<T extends z.ZodType>(path: string, ref: string, item: T): Promise<z.infer<T>[]> {
        const pageSchema = listPageSchema(item);
        const items: z.infer<T>[] = [];
        for (let page = 1; ; page++) {
            const query = new URLSearchParams({ "metadata[reference_id]": ref, limit: String(POLAR_PAGE_LIMIT), page: String(page) });
            const parsed = pageSchema.safeParse(await request(`${path}?${query.toString()}`));
            if (!parsed.success) throw new PolarRequestError(`Polar ${path} response did not match the expected shape`, null);
            items.push(...parsed.data.items);
            if (page >= parsed.data.pagination.max_page) return items;
        }
    }

    return {
        listSubscriptionsForRef: async (ref) => await listAll("/v1/subscriptions/", ref, PolarSubscriptionSchema),
        listOrdersForRef: async (ref) => await listAll("/v1/orders/", ref, PolarOrderSchema),
    };
}
