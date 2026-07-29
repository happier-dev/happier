import { ProviderModelIdSchema } from './ids.js';

export type ProviderManualModelInputResult = Readonly<{
  accepted: readonly string[];
  rejected: readonly Readonly<{ line: number; value: string }>[];
}>;

function safeRejectedModelId(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 512);
}

/** Canonical boundary parser for multiline manual model entry across UI and CLI. */
export function parseProviderManualModelInput(
  raw: string,
  options: Readonly<{ existingIds?: ReadonlySet<string> }> = {},
): ProviderManualModelInputResult {
  const accepted: string[] = [];
  const rejected: Array<Readonly<{ line: number; value: string }>> = [];
  const seen = new Set<string>();
  raw.split(/\r?\n/u).forEach((line, index) => {
    const candidate = line.trim();
    if (!candidate) return;
    const parsed = ProviderModelIdSchema.safeParse(candidate);
    if (!parsed.success) {
      rejected.push({ line: index + 1, value: safeRejectedModelId(candidate) });
      return;
    }
    if (seen.has(parsed.data)) return;
    seen.add(parsed.data);
    if (!options.existingIds?.has(parsed.data)) accepted.push(parsed.data);
  });
  return { accepted, rejected };
}
