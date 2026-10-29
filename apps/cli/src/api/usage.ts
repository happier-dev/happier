import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { z } from 'zod/mini';

export const UsageSchema = lazyZodSchema(() => z.looseObject({
    // Usage statistics for assistant messages.
    // This is intentionally passthrough() to keep forward-compatible with new vendor fields.
    input_tokens: z.number().check(z.int(), z.nonnegative()),
    cache_creation_input_tokens: z.optional(z.number().check(z.int(), z.nonnegative())),
    cache_read_input_tokens: z.optional(z.number().check(z.int(), z.nonnegative())),
    output_tokens: z.number().check(z.int(), z.nonnegative()),
    // Some upstream providers emit `service_tier: null` in error payloads.
    // Treat null as “unknown” so we don't drop the whole message.
    service_tier: z.nullish(z.string()),
}));

export type Usage = z.infer<typeof UsageSchema>;
