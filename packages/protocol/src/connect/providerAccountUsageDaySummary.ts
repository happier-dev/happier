import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import { PROVIDER_ACCOUNT_USAGE_DAY_MS, ProviderAccountUsageRecordIdSchema } from './providerAccountUsagePrimitives.js';
import { PackedProviderAccountUsageDaySummaryV1Schema, packProviderAccountUsageDaySummaryV1,
  unpackProviderAccountUsageDaySummaryV1, PROVIDER_ACCOUNT_USAGE_DAY_SUMMARY_ENCODING } from './providerAccountUsageDaySummaryEncoding.js';
import { ProviderAccountUsageDaySummaryV1Schema, matchesProviderAccountUsageDaySummaryIdentityV1, type ProviderAccountUsageDaySummaryV1 } from './providerAccountUsageDaySummaryModel.js';

export { packProviderAccountUsageDaySummaryV1, PROVIDER_ACCOUNT_USAGE_DAY_SUMMARY_ENCODING } from './providerAccountUsageDaySummaryEncoding.js';

export { PROVIDER_ACCOUNT_USAGE_DAY_MS } from './providerAccountUsagePrimitives.js';
const Time = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
const Day = lazyZodSchema(() => Time.check(z.refine(value => value % PROVIDER_ACCOUNT_USAGE_DAY_MS === 0)));
export { ProviderAccountUsageDaySummaryWindowV1Schema, ProviderAccountUsageDaySummaryV1Schema, type ProviderAccountUsageDaySummaryV1,
  matchesProviderAccountUsageDaySummaryIdentityV1, buildProviderAccountUsageDaySummaryV1, deriveProviderAccountUsageDayQuotaHistoryV1 } from './providerAccountUsageDaySummaryModel.js';
export const ProviderAccountUsageDaySummaryCoverageV1Schema = lazyZodSchema(() => z.strictObject({
  observationCount: z.number().check(z.int(), z.nonnegative()),
  frontier: z.nullable(z.strictObject({ id: z.string().check(z.minLength(1)), observedAtMs: Time })),
}));
export const ProviderAccountUsageDaySummaryContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: z.union([PackedProviderAccountUsageDaySummaryV1Schema, ProviderAccountUsageDaySummaryV1Schema]) }),
  z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }),
]));
export const StoredProviderAccountUsageDaySummaryV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), coverage: ProviderAccountUsageDaySummaryCoverageV1Schema, content: ProviderAccountUsageDaySummaryContentV1Schema,
  clockBoundsVersion: z.optional(z.literal(1)),
  encoding: z.optional(z.literal(PROVIDER_ACCOUNT_USAGE_DAY_SUMMARY_ENCODING)),
}));
export type StoredProviderAccountUsageDaySummaryV1 = z.infer<typeof StoredProviderAccountUsageDaySummaryV1Schema>;
export const ProviderAccountUsageDaySummaryReadV1Schema = lazyZodSchema(() => z.strictObject({
  recordId: ProviderAccountUsageRecordIdSchema,
  /** Omit only for all-days coverage; no client-selected timestamp ceiling. */
  range: z.optional(z.strictObject({ startAtMs: Time, endAtMs: Time }).check(z.refine(value => value.endAtMs > value.startAtMs))),
  includeMissingDays: z.optional(z.boolean()),
  /** Return all selected envelopes with pending coverage, without producer predecessor bodies. */
  includeCoverage: z.optional(z.boolean()),
  requireClockBounds: z.optional(z.boolean()),
  requireCompact: z.optional(z.boolean()),
}).check(z.refine(value => value.range !== undefined || value.includeCoverage === true)));
export const ProviderAccountUsageDaySummaryResponseV1Schema = lazyZodSchema(() => z.strictObject({
  summaries: z.array(z.strictObject({ dayStartAtMs: Day, payload: StoredProviderAccountUsageDaySummaryV1Schema })),
  missingDays: z.array(z.strictObject({ dayStartAtMs: Day, coverage: ProviderAccountUsageDaySummaryCoverageV1Schema,
    /** Selected only to rewrite the encoding, with no pending observations. */
    rewriteOnly: z.optional(z.literal(true)),
    precedingSummary: z.optional(z.strictObject({ dayStartAtMs: Day, payload: StoredProviderAccountUsageDaySummaryV1Schema })) })),
}));
export const ProviderAccountUsageDaySummaryWriteV1Schema = lazyZodSchema(() => z.strictObject({
  recordId: ProviderAccountUsageRecordIdSchema, dayStartAtMs: Day, payload: StoredProviderAccountUsageDaySummaryV1Schema,
}));

export function sealProviderAccountUsageDaySummaryV1(input: Readonly<{ summary: ProviderAccountUsageDaySummaryV1; material: AccountScopedCryptoMaterial; randomBytes: (length: number) => Uint8Array }>) {
  return { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'provider_account_usage_day_summary', material: input.material,
    payload: packProviderAccountUsageDaySummaryV1(ProviderAccountUsageDaySummaryV1Schema.parse(input.summary)), randomBytes: input.randomBytes }) };
}
export function openProviderAccountUsageDaySummaryV1(input: Readonly<{ recordId: string; dayStartAtMs: number; accountMode: 'plain' | 'e2ee';
  material?: AccountScopedCryptoMaterial; content: z.infer<typeof ProviderAccountUsageDaySummaryContentV1Schema> }>): ProviderAccountUsageDaySummaryV1 {
  if ((input.accountMode === 'plain') !== (input.content.t === 'plain')) throw new Error('provider_account_usage_summary_mode_mismatch');
  const opened = input.content.t === 'plain' ? input.content.v : input.material
    ? openAccountScopedBlobCiphertext({ kind: 'provider_account_usage_day_summary', material: input.material, ciphertext: input.content.c })?.value : null;
  const packed = PackedProviderAccountUsageDaySummaryV1Schema.safeParse(opened);
  const summary = packed.success ? packed.data : ProviderAccountUsageDaySummaryV1Schema.parse(opened);
  if (!matchesProviderAccountUsageDaySummaryIdentityV1(summary, input)) throw new Error('provider_account_usage_summary_identity_mismatch');
  return 'encoding' in summary ? unpackProviderAccountUsageDaySummaryV1(summary) : summary;
}
