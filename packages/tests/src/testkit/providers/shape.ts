function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type Shape =
  | { t: 'null' }
  | { t: 'boolean' }
  | { t: 'number' }
  | { t: 'string' }
  | { t: 'array'; item: Shape | null }
  | { t: 'object'; keys: Record<string, Shape> };

export function shapeOf(value: unknown, opts?: { maxKeys?: number; maxDepth?: number }): Shape {
  const maxKeys = opts?.maxKeys ?? 50;
  const maxDepth = opts?.maxDepth ?? 8;

  const inner = (v: unknown, depth: number): Shape => {
    if (depth <= 0) {
      if (Array.isArray(v)) return { t: 'array', item: null };
      if (isRecord(v)) return { t: 'object', keys: {} };
    }
    if (v === null) return { t: 'null' };
    if (typeof v === 'boolean') return { t: 'boolean' };
    if (typeof v === 'number') return { t: 'number' };
    if (typeof v === 'string') return { t: 'string' };
    if (Array.isArray(v)) {
      if (v.length === 0) return { t: 'array', item: null };
      return { t: 'array', item: inner(v[0], depth - 1) };
    }
    if (isRecord(v)) {
      const entries = Object.entries(v).slice(0, maxKeys);
      const keys: Record<string, Shape> = {};
      for (const [k, val] of entries) {
        keys[k] = inner(val, depth - 1);
      }
      return { t: 'object', keys };
    }
    return { t: 'string' };
  };

  return inner(value, maxDepth);
}

export function stableStringifyShape(shape: Shape): string {
  const sortKeys = (obj: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = obj[key];
    return out;
  };

  const normalize = (s: Shape): any => {
    if (s.t === 'object') {
      const keys: Record<string, any> = {};
      for (const [k, v] of Object.entries(s.keys)) keys[k] = normalize(v);
      return { t: 'object', keys: sortKeys(keys) };
    }
    if (s.t === 'array') return { t: 'array', item: s.item ? normalize(s.item) : null };
    return s;
  };

  return JSON.stringify(normalize(shape));
}

