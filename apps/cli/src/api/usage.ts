import { z } from 'zod';

export const UsageSchema = z.object({
    // Usage statistics for assistant messages.
    // This is intentionally passthrough() to keep forward-compatible with new vendor fields.
    input_tokens: z.number().int().nonnegative(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional(),
    cache_read_input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative(),
    // Some upstream providers emit `service_tier: null` in error payloads.
    // Treat null as “unknown” so we don't drop the whole message.
    service_tier: z.string().nullish(),
}).passthrough();

export type Usage = z.infer<typeof UsageSchema>;
