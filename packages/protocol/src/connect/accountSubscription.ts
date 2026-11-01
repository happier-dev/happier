import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const PROVIDER_ACCOUNT_SUBSCRIPTION_ACCEPT = 'application/json; happier-account-subscription=1';

export const SealedProviderAccountSubscriptionV1Schema = lazySchema(() => z.object({
  ciphertext: z.string().min(1),
  observedAtMs: z.number().int().nonnegative(),
}).strict());

export const ProviderAccountSubscriptionV1Schema = lazySchema(() => z.object({
  status: z.enum(['subscribed', 'none', 'unavailable']),
  renewal: z.enum(['on', 'off', 'unknown']),
  observedAtMs: z.number().int().nonnegative(),
  staleAfterMs: z.number().int().positive(),
  currentPeriodStartAtMs: z.number().int().nonnegative().optional(),
  currentPeriodEndAtMs: z.number().int().nonnegative().optional(),
  lastRefreshError: z.object({
    observedAtMs: z.number().int().nonnegative(),
    code: z.enum(['network', 'malformed', 'provider_backoff', 'auth_failure', 'missing_auth']),
    status: z.number().int().min(100).max(599).optional(),
  }).strict().optional(),
}).strict());

export type ProviderAccountSubscriptionV1 = z.infer<typeof ProviderAccountSubscriptionV1Schema>;

export function mergeProviderAccountSubscription(
  previous: ProviderAccountSubscriptionV1 | undefined,
  incoming: ProviderAccountSubscriptionV1 | undefined,
): ProviderAccountSubscriptionV1 | undefined {
  if (!incoming) return previous;
  if (!previous) return incoming;
  const previousCheckedAt = Math.max(previous.observedAtMs, previous.lastRefreshError?.observedAtMs ?? 0);
  const incomingCheckedAt = Math.max(incoming.observedAtMs, incoming.lastRefreshError?.observedAtMs ?? 0);
  if (incomingCheckedAt < previousCheckedAt) return previous;
  if (incoming.status === 'unavailable' && previous.status !== 'unavailable') {
    return incoming.lastRefreshError
      ? { ...previous, lastRefreshError: incoming.lastRefreshError }
      : previous;
  }
  return incoming;
}
