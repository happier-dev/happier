import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { isConnectedServiceQuotaObservationFresh } from './quotaObservationTime.js';

export const ProviderAccountSubscriptionMonthlyPriceV1Schema = lazyZodSchema(() => z.strictObject({
  amount: z.number().check(z.nonnegative()), currency: z.string().check(z.regex(/^[A-Z]{3}$/)), enteredAtMs: z.number().check(z.int(), z.nonnegative()),
}));
export type ProviderAccountSubscriptionMonthlyPriceV1 = z.infer<typeof ProviderAccountSubscriptionMonthlyPriceV1Schema>;

export const PROVIDER_ACCOUNT_SUBSCRIPTION_ACCEPT = 'application/json; happier-account-subscription=1';
export const SealedProviderAccountSubscriptionV1Schema = lazyZodSchema(() => z.strictObject({ ciphertext: z.string().check(z.minLength(1)), observedAtMs: z.number().check(z.int(), z.nonnegative()) }));
export const ProviderAccountSubscriptionMonetaryFactV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['paid', 'list']),
  amount: z.number().check(z.nonnegative()),
  currency: z.string().check(z.regex(/^[A-Z]{3}$/)),
  period: z.strictObject({ startAtMs: z.number().check(z.int(), z.nonnegative()), endAtMs: z.number().check(z.int(), z.nonnegative()) }).check(z.refine(period => period.endAtMs > period.startAtMs)),
  source: z.strictObject({ kind: z.enum(['provider', 'published']), id: z.string().check(z.minLength(1)), version: z.string().check(z.minLength(1)) }),
  effectiveAtMs: z.number().check(z.int(), z.nonnegative()),
  asOfMs: z.number().check(z.int(), z.nonnegative()),
  tier: z.optional(z.string().check(z.minLength(1))),
  region: z.optional(z.string().check(z.minLength(1))),
}).check(z.refine(fact => fact.kind !== 'paid' || fact.source.kind === 'provider', { path: ['source', 'kind'], message: 'Actual payment requires an Account payment source' })));
export type ProviderAccountSubscriptionMonetaryFactV1 = z.infer<typeof ProviderAccountSubscriptionMonetaryFactV1Schema>;
export type ProviderAccountSubscriptionEnteredFactV1 = Omit<ProviderAccountSubscriptionMonetaryFactV1, 'kind' | 'source'> & Readonly<{
  kind: 'entered'; source: { kind: 'user'; id: 'you-entered'; version: '1' };
}>;
export type ProviderAccountSubscriptionPriceSelectionV1 = Readonly<{ paid: ProviderAccountSubscriptionMonetaryFactV1 | null;
  list: ProviderAccountSubscriptionMonetaryFactV1 | null; entered: ProviderAccountSubscriptionEnteredFactV1 | null }>;
export const ProviderAccountSubscriptionV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['subscribed', 'none', 'unavailable']),
  renewal: z.enum(['on', 'off', 'unknown']),
  observedAtMs: z.number().check(z.int(), z.nonnegative()),
  staleAfterMs: z.number().check(z.int(), z.positive()),
  currentPeriodStartAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  currentPeriodEndAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  monetaryFacts: z.optional(z.array(ProviderAccountSubscriptionMonetaryFactV1Schema)),
  enteredMonthlyPrice: z.optional(ProviderAccountSubscriptionMonthlyPriceV1Schema),
  lastRefreshError: z.optional(z.strictObject({ observedAtMs: z.number().check(z.int(), z.nonnegative()), code: z.enum(['network', 'malformed', 'provider_backoff', 'auth_failure', 'missing_auth']), status: z.optional(z.number().check(z.int(), z.minimum(100), z.maximum(599))) })),
}));
export type ProviderAccountSubscriptionV1 = z.infer<typeof ProviderAccountSubscriptionV1Schema>;

/** Current-period price observations, never an inferred payment or a historical/future quote. */
export function projectProviderAccountSubscriptionMonetaryFacts(input: Readonly<{
  subscription: ProviderAccountSubscriptionV1 | null | undefined;
  nowMs: number;
  tier?: string | null;
  region?: string | null;
}>): ProviderAccountSubscriptionPriceSelectionV1 {
  const empty = { paid: null, list: null, entered: null };
  const subscription = input.subscription;
  const start = subscription?.currentPeriodStartAtMs;
  const end = subscription?.currentPeriodEndAtMs;
  if (!subscription || subscription.status !== 'subscribed' || start === undefined || end === undefined
    || start >= end || input.nowMs < start || input.nowMs >= end
    || !isConnectedServiceQuotaObservationFresh({ observedAtMs: subscription.observedAtMs, nowMs: input.nowMs, maxAgeMs: subscription.staleAfterMs })) return empty;
  const eligible = (fact: ProviderAccountSubscriptionMonetaryFactV1) => fact.period.startAtMs === start && fact.period.endAtMs === end
    && fact.effectiveAtMs <= Math.min(input.nowMs, subscription.observedAtMs)
    && fact.asOfMs <= Math.min(input.nowMs, subscription.observedAtMs)
    && fact.effectiveAtMs <= fact.asOfMs
    && (fact.tier === undefined || fact.tier === input.tier)
    && (fact.region === undefined || fact.region === input.region);
  const latest = (kind: ProviderAccountSubscriptionMonetaryFactV1['kind']) => (subscription.monetaryFacts ?? [])
    .filter(fact => fact.kind === kind && eligible(fact))
    .reduce<ProviderAccountSubscriptionMonetaryFactV1 | null>((best, fact) => !best || fact.effectiveAtMs > best.effectiveAtMs
      || (fact.effectiveAtMs === best.effectiveAtMs && fact.asOfMs > best.asOfMs) ? fact : best, null);
  const price = subscription.enteredMonthlyPrice;
  return { paid: latest('paid'), list: latest('list'), entered: price && price.enteredAtMs <= input.nowMs ? {
    kind: 'entered', amount: price.amount, currency: price.currency, period: { startAtMs: start, endAtMs: end },
    source: { kind: 'user', id: 'you-entered', version: '1' }, effectiveAtMs: price.enteredAtMs, asOfMs: price.enteredAtMs,
  } : null };
}
export function mergeProviderAccountSubscription(previous: ProviderAccountSubscriptionV1 | undefined, incoming: ProviderAccountSubscriptionV1 | undefined): ProviderAccountSubscriptionV1 | undefined {
  if (!incoming) return previous;
  if (!previous) return incoming;
  const previousCheckedAt = Math.max(previous.observedAtMs, previous.lastRefreshError?.observedAtMs ?? 0);
  const incomingCheckedAt = Math.max(incoming.observedAtMs, incoming.lastRefreshError?.observedAtMs ?? 0);
  if (incomingCheckedAt < previousCheckedAt) return previous;
  if (incoming.status === 'unavailable' && previous.status !== 'unavailable') return incoming.lastRefreshError ? { ...previous, lastRefreshError: incoming.lastRefreshError } : previous;
  // A quota/subscription refresh without a monetary observation cannot erase
  // retained dated facts. The period selector decides whether they apply now.
  if (incoming.monetaryFacts === undefined && previous.monetaryFacts !== undefined) return { ...incoming, monetaryFacts: previous.monetaryFacts };
  return incoming;
}
