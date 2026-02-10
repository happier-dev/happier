type PayloadSubstringScanOptions = {
  maxNodes?: number;
  maxStringLength?: number;
};

function resolveOptions(opts?: PayloadSubstringScanOptions): Required<PayloadSubstringScanOptions> {
  return {
    maxNodes: typeof opts?.maxNodes === 'number' && Number.isFinite(opts.maxNodes) ? Math.max(1, Math.floor(opts.maxNodes)) : 2_000,
    maxStringLength:
      typeof opts?.maxStringLength === 'number' && Number.isFinite(opts.maxStringLength)
        ? Math.max(1, Math.floor(opts.maxStringLength))
        : 20_000,
  };
}

export function payloadContainsSubstring(payload: unknown, needle: string, opts?: PayloadSubstringScanOptions): boolean {
  const { maxNodes, maxStringLength } = resolveOptions(opts);
  const seen = new WeakSet<object>();
  const stack: unknown[] = [payload];
  let visited = 0;

  while (stack.length > 0) {
    if (visited++ > maxNodes) return false;
    const value = stack.pop();

    if (typeof value === 'string') {
      if (value.length <= maxStringLength && value.includes(needle)) return true;
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      if (String(value).includes(needle)) return true;
      continue;
    }
    if (!value || typeof value !== 'object') continue;

    if (seen.has(value)) continue;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
      continue;
    }

    for (const [k, v] of Object.entries(value)) {
      if (k.includes(needle)) return true;
      stack.push(v);
    }
  }

  return false;
}

