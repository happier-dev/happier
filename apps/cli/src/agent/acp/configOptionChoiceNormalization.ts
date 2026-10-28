function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizeAcpConfigOptionChoices<TValue>(
  rawOptions: unknown,
  normalizeValue: (value: unknown) => TValue | null,
): Array<{ value: TValue; name: string; description?: string }> {
  if (!Array.isArray(rawOptions)) return [];

  const out: Array<{ value: TValue; name: string; description?: string }> = [];
  const visit = (entries: ReadonlyArray<unknown>): void => {
    for (const rawEntry of entries) {
      const entry = asRecord(rawEntry);
      if (!entry) continue;

      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      const value = normalizeValue(entry.value);
      if (value !== null && name) {
        const description = typeof entry.description === 'string' ? entry.description.trim() : '';
        out.push({ value, name, ...(description ? { description } : {}) });
      }

      if (Array.isArray(entry.options)) {
        visit(entry.options);
      }
    }
  };

  visit(rawOptions);
  return out;
}

/** Resolve one selector; category=model may also describe providers or model controls. */
export function resolveAcpModelConfigOption<T extends {
  id?: unknown;
  name?: unknown;
  category?: unknown;
  type?: unknown;
  options?: unknown;
}>(options: ReadonlyArray<T>, declaredId?: string | null): T | null {
  const selectors = options.filter((option) => Array.isArray(option.options)
    && (option.type === undefined || option.type === 'select' || option.type === 'enum'));
  if (declaredId) {
    // Wire ids are opaque, including whitespace and case.
    const declared = selectors.filter((option) => option.id === declaredId);
    if (declared.length > 0) return declared.length === 1 ? declared[0] : null;
  }
  const named = selectors.filter((option) => option.id === 'model'
    || (typeof option.name === 'string' && option.name.trim().toLowerCase() === 'model'));
  if (named.length > 0) return named.length === 1 ? named[0] : null;
  const categorized = selectors.filter((option) => typeof option.category === 'string'
    && option.category.trim().toLowerCase() === 'model');
  return categorized.length === 1 ? categorized[0] : null;
}

export function isAcpModeConfigOptionLike(value: {
  id?: unknown;
  name?: unknown;
  category?: unknown;
}): boolean {
  const id = typeof value.id === 'string' ? value.id.trim().toLowerCase() : '';
  const name = typeof value.name === 'string' ? value.name.trim().toLowerCase() : '';
  const category = typeof value.category === 'string' ? value.category.trim().toLowerCase() : '';
  return category === 'mode' || id === 'mode' || name === 'mode';
}
