import type { SessionId } from '@happier-dev/plugin-sdk/sessions';

/** The public review-engine choice shape presented to a reader. */
export type TriageReviewEngineOptionV1 = Readonly<{
  value: string;
  label: string;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Admits the incumbent review.engines.list projection without creating an
 * engine registry or resolving labels a second time.
 */
export function readAvailableEngineOptions(
  value: unknown,
  sessionId: SessionId,
): readonly TriageReviewEngineOptionV1[] | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  if (value.sessionId !== undefined && value.sessionId !== sessionId) return null;

  const options: TriageReviewEngineOptionV1[] = [];
  const seen = new Set<string>();
  for (const item of value.items) {
    if (!isRecord(item) || typeof item.engineId !== 'string' || typeof item.label !== 'string') return null;
    const optionValue = item.engineId.trim();
    const label = item.label.trim();
    if (optionValue.length === 0 || label.length === 0 || seen.has(optionValue)) return null;
    seen.add(optionValue);
    if (item.enabled !== false) options.push(Object.freeze({ value: optionValue, label }));
  }
  return Object.freeze(options);
}
