import { z } from 'zod';

/** Public lifecycle facts shared by the plain and sealed quota read adapters. */
export const ConnectedServiceQuotaReadMetadataSchema = z.object({
    fetchedAt: z.number().int().nonnegative(),
    staleAfterMs: z.number().int().nonnegative(),
    status: z.enum(['ok', 'unavailable', 'estimated', 'error']),
    refreshRequestedAt: z.number().int().nonnegative().optional(),
    refreshErrorAt: z.number().int().nonnegative().optional(),
});

export type ConnectedServiceQuotaReadMetadata = z.infer<typeof ConnectedServiceQuotaReadMetadataSchema>;
