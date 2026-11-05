import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { RegistryItemSummaryV1Schema } from './registryItemsV1.js';
import { MarketplaceCatalogDiscoveryV1Schema } from '../marketplace/marketplaceIndexV1.js';

export const RegistrySourceStatusV1Schema = lazyZodSchema(() => z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('ok'), fetchedAt: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ state: z.literal('rate_limited'), retryAt: z.optional(z.number().check(z.int(), z.nonnegative())) }),
  ...(['unreachable', 'auth_failed', 'needs_machine', 'invalid_source'] as const).map(state => z.strictObject({ state: z.literal(state) })),
  z.strictObject({ state: z.literal('newer_format'), found: z.string() }),
]));
export type RegistrySourceStatusV1 = z.infer<typeof RegistrySourceStatusV1Schema>;

/** HTTP reset evidence is shared by platform and daemon transports. Headerless
 * limits remain observable and impose no host throttle or invented cooldown. */
export function readRegistryHttpRateLimitV1(input: Readonly<{ status: number;
  headers: Readonly<{ get(name: string): string | null }>; nowMs: number }>):
  Extract<RegistrySourceStatusV1, { state: 'rate_limited' }> | null {
  if (input.status !== 429 && !(input.status === 403 && input.headers.get('x-ratelimit-remaining') === '0')) return null;
  const retryAfter = input.headers.get('retry-after')?.trim();
  const reset = input.headers.get('x-ratelimit-reset')?.trim();
  const seconds = /^\d+(?:\.\d+)?$/;
  const retryAt = retryAfter ? seconds.test(retryAfter) ? input.nowMs + Number(retryAfter) * 1000
    : Number.isFinite(Number(retryAfter)) ? NaN : Date.parse(retryAfter) : NaN;
  const timestamp = Number.isFinite(retryAt) && retryAt >= 0 ? retryAt
    : reset && seconds.test(reset) ? Number(reset) * 1000 : NaN;
  return Number.isFinite(timestamp) && timestamp >= 0
    ? { state: 'rate_limited', retryAt: Math.ceil(timestamp) } : { state: 'rate_limited' };
}
export const RegistryListPageV1Schema = lazyZodSchema(() => z.strictObject({
  sourceId: z.string().check(z.minLength(1)), status: RegistrySourceStatusV1Schema, items: z.array(RegistryItemSummaryV1Schema),
  nextCursor: z.nullable(z.string()), total: z.optional(z.number().check(z.int(), z.nonnegative())), machineId: z.optional(z.string().check(z.minLength(1))),
  discovery: z.optional(MarketplaceCatalogDiscoveryV1Schema),
}));
export type RegistryListPageV1 = z.infer<typeof RegistryListPageV1Schema>;
export class RegistryFetchErrorV1 extends Error {
  readonly code: Exclude<RegistrySourceStatusV1, { state: 'ok' }>['state'];
  constructor(readonly status: Exclude<RegistrySourceStatusV1, { state: 'ok' }>) {
    super(status.state); this.code = status.state;
  }
}
