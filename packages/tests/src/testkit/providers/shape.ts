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

export function normalizeShapeForBaseline(shape: Shape): Shape {
  if (shape.t === 'array') {
    return { t: 'array', item: shape.item ? normalizeShapeForBaseline(shape.item) : null };
  }
  if (shape.t === 'object') {
    const isSearchLike = 'query' in shape.keys || 'pattern' in shape.keys;
    const isToolEnvelope = '_happier' in shape.keys || '_acp' in shape.keys || '_raw' in shape.keys || 'toolCallId' in shape.keys;
    const keys: Record<string, Shape> = {};
    for (const [k, v] of Object.entries(shape.keys)) {
      // Provider-specific meta subtrees are intentionally treated as opaque for drift baselines.
      // We validate canonical fields via protocol schemas; baselines should focus on stable surface area.
      if (k === '_raw' || k === '_acp') {
        keys[k] = { t: 'string' };
      } else if (k === 'description' && isToolEnvelope) {
        // Human-oriented labels frequently differ (or are omitted) across provider implementations.
        // Baselines should not drift on these.
      } else if (k === 'path' && isSearchLike) {
        // Search tools sometimes include an explicit search root (`path`) and sometimes infer it from cwd/locations.
        // Treat it as optional so baselines don't drift on presence/absence.
      } else {
        keys[k] = normalizeShapeForBaseline(v);
      }
    }
    return { t: 'object', keys };
  }
  return shape;
}

function mergeShapeSamples(base: Shape, sample: Shape): Shape {
  if (base.t === 'object' && sample.t === 'object') {
    const mergedKeys: Record<string, Shape> = { ...base.keys };
    for (const [k, v] of Object.entries(sample.keys)) {
      mergedKeys[k] = mergedKeys[k] ? mergeShapeSamples(mergedKeys[k], v) : v;
    }
    return { t: 'object', keys: mergedKeys };
  }

  if (base.t === 'array' && sample.t === 'array') {
    if (!base.item) return { t: 'array', item: sample.item };
    if (!sample.item) return base;
    return { t: 'array', item: mergeShapeSamples(base.item, sample.item) };
  }

  // Preserve first-observed primitive/container kind on incompatible merges to avoid
  // broadening baseline expectations from mixed payload noise.
  return base;
}

export function shapeOf(value: unknown, opts?: { maxKeys?: number; maxDepth?: number; maxArraySample?: number }): Shape {
  const maxKeys = opts?.maxKeys ?? 50;
  const maxDepth = opts?.maxDepth ?? 8;
  const maxArraySample = opts?.maxArraySample ?? 5;

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
      const sampled = v.slice(0, Math.max(1, maxArraySample));
      let itemShape: Shape | null = null;
      for (const item of sampled) {
        const shape = inner(item, depth - 1);
        itemShape = itemShape ? mergeShapeSamples(itemShape, shape) : shape;
      }
      return { t: 'array', item: itemShape };
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
