import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { MarketplaceSourceRegistryV1Schema } from './marketplaceSourceRegistryV1.js';

const HostPrivateMarketplaceSourceRegistryMutationInvalidRequestV1Schema = lazyZodSchema(() => z.object({
  ok: z.literal(false),
  errorCode: z.literal('invalid_request'),
  error: z.string().trim().min(1).max(1_024),
}).strict());

/**
 * Host-private settlement for one marketplace-source mutation.
 *
 * The committed arm deliberately remains the registry itself: this closes the
 * previously implicit daemon/UI contract without introducing a second success
 * envelope for an unpublished private wire.
 */
export const HostPrivateMarketplaceSourceRegistryMutationResponseV1Schema = lazyZodSchema(() => z.union([
  MarketplaceSourceRegistryV1Schema,
  HostPrivateMarketplaceSourceRegistryMutationInvalidRequestV1Schema,
]));

export type HostPrivateMarketplaceSourceRegistryMutationResponseV1 = z.infer<
  typeof HostPrivateMarketplaceSourceRegistryMutationResponseV1Schema
>;
