import { asRecord, normalizeString } from '../runtime/server/openCodeParsing.js';

export type OpenCodeModelOption = Readonly<{
  id: 'reasoning_effort';
  name: 'Thinking';
  type: 'select';
  currentValue: string;
  options: ReadonlyArray<Readonly<{ value: string; name: string }>>;
}>;

function variantSupportsReasoningEffort(raw: unknown): boolean {
  const rec = asRecord(raw);
  if (!rec) return false;
  const reasoningEffort = normalizeString(rec.reasoningEffort);
  if (reasoningEffort) return true;
  return asRecord(rec.thinking) !== null;
}

function formatVariantName(raw: string): string {
  const id = raw.trim();
  const lower = id.toLowerCase();
  if (lower === 'low') return 'Low';
  if (lower === 'medium') return 'Medium';
  if (lower === 'high') return 'High';
  if (lower === 'max') return 'Max';
  if (lower === 'minimal') return 'Minimal';
  if (id.length === 0) return id;
  return id.slice(0, 1).toUpperCase() + id.slice(1);
}

function sortVariantIds(ids: ReadonlyArray<string>): string[] {
  const preferred = ['minimal', 'low', 'medium', 'high', 'max', 'xhigh'];
  const preferredIndex = new Map(preferred.map((value, index) => [value, index]));
  return [...ids].sort((a, b) => {
    const ai = preferredIndex.get(a.toLowerCase());
    const bi = preferredIndex.get(b.toLowerCase());
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    return a.localeCompare(b);
  });
}

export function buildOpenCodeThinkingModelOptionsFromVariants(
  variantsRaw: unknown,
  currentValueCandidate: string | null,
): readonly OpenCodeModelOption[] | null {
  const variants = asRecord(variantsRaw);
  if (!variants) return null;

  const variantIds = Object.keys(variants).filter((key) => variantSupportsReasoningEffort(variants[key]));
  if (variantIds.length === 0) return null;

  const sorted = sortVariantIds(variantIds);
  const currentValue =
    currentValueCandidate && sorted.includes(currentValueCandidate)
      ? currentValueCandidate
      : sorted.includes('medium')
        ? 'medium'
        : sorted.includes('high')
          ? 'high'
          : sorted[0] ?? 'medium';

  return [{
    id: 'reasoning_effort',
    name: 'Thinking',
    type: 'select',
    currentValue,
    options: sorted.map((id) => ({ value: id, name: formatVariantName(id) })),
  }];
}
