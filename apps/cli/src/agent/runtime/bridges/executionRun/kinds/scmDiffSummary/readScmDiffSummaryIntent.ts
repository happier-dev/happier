export function readScmDiffSummaryIntent(input: unknown): Readonly<Record<string, unknown>> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Readonly<Record<string, unknown>> : {};
}
