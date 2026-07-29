/**
 * Canonical plain-record guard for redaction/egress walkers: a non-null object that is NOT an
 * array (arrays are walked element-wise by the callers). Collapsed from per-file clones in the
 * browser redaction modules (RU2 capstone L2-6).
 *
 * Note: `features/payload/isRecord.ts` is a DIFFERENT predicate (it admits arrays) serving the
 * features-payload parser; do not merge the two.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
