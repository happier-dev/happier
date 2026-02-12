type TokenCountExtraction = {
  key: string | null;
  modelId: string | null;
  tokens: Record<string, number>;
};

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asFiniteNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function createSafeNumberMap(): Record<string, number> {
  // Null-prototype objects avoid `__proto__` mutation semantics.
  return Object.create(null) as Record<string, number>;
}

function normalizeTokenMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return createSafeNumberMap();
  const out = createSafeNumberMap();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const num = asFiniteNonNegativeNumber(value);
    if (num == null) continue;
    out[key] = num;
  }
  return out;
}

function computeTotalFromParts(parts: {
  input?: number;
  output?: number;
  cache_creation?: number;
  cache_read?: number;
  thought?: number;
}): number {
  return (
    (parts.input ?? 0) +
    (parts.output ?? 0) +
    (parts.cache_creation ?? 0) +
    (parts.cache_read ?? 0) +
    (parts.thought ?? 0)
  );
}

export function extractTokensFromAcpTokenCountMessage(body: unknown): TokenCountExtraction | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;

  const key = asNonEmptyString(record.key);
  const modelId = asNonEmptyString(record.model ?? record.modelId);

  // Preferred: a nested tokens map.
  const nested = normalizeTokenMap(record.tokens);
  if (Object.keys(nested).length > 0) {
    if (nested.total == null) {
      const hasParts =
        nested.input != null ||
        nested.output != null ||
        nested.cache_creation != null ||
        nested.cache_read != null ||
        nested.thought != null;
      if (hasParts) {
        nested.total = computeTotalFromParts({
          input: nested.input,
          output: nested.output,
          cache_creation: nested.cache_creation,
          cache_read: nested.cache_read,
          thought: nested.thought,
        });
      }
    }
    return { key, modelId, tokens: nested };
  }

  // Fallback: common top-level fields (OpenAI-like naming and variants).
  const input =
    asFiniteNonNegativeNumber(record.input_tokens) ??
    asFiniteNonNegativeNumber(record.input) ??
    asFiniteNonNegativeNumber(record.prompt_tokens);
  const output =
    asFiniteNonNegativeNumber(record.output_tokens) ??
    asFiniteNonNegativeNumber(record.output) ??
    asFiniteNonNegativeNumber(record.completion_tokens);
  const cacheCreation =
    asFiniteNonNegativeNumber(record.cache_creation_input_tokens) ??
    asFiniteNonNegativeNumber(record.cache_creation);
  const cacheRead =
    asFiniteNonNegativeNumber(record.cache_read_input_tokens) ??
    asFiniteNonNegativeNumber(record.cache_read);
  const thought =
    asFiniteNonNegativeNumber(record.thought_tokens) ??
    asFiniteNonNegativeNumber(record.thought);

  const anyPresent = input != null || output != null || cacheCreation != null || cacheRead != null || thought != null;
  if (!anyPresent) return null;

  const tokens = createSafeNumberMap();
  tokens.total = computeTotalFromParts({
    input: input ?? undefined,
    output: output ?? undefined,
    cache_creation: cacheCreation ?? undefined,
    cache_read: cacheRead ?? undefined,
    thought: thought ?? undefined,
  });
  if (input != null) tokens.input = input;
  if (output != null) tokens.output = output;
  if (cacheCreation != null) tokens.cache_creation = cacheCreation;
  if (cacheRead != null) tokens.cache_read = cacheRead;
  if (thought != null) tokens.thought = thought;

  return { key, modelId, tokens };
}
