import { LruSet } from '@/utils/collections/lru';

export type ValueShapeSummary =
  | { kind: 'null' }
  | { kind: 'undefined' }
  | { kind: 'string'; length: number }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'bigint' }
  | { kind: 'symbol' }
  | { kind: 'function' }
  | { kind: 'date'; iso: string }
  | { kind: 'error'; name: string; messageLength: number }
  | { kind: 'circular' }
  | { kind: 'truncated'; type: string }
  | { kind: 'array'; length: number; items: ValueShapeSummary[]; truncated: boolean }
  | { kind: 'object'; keys: string[]; fields: Record<string, ValueShapeSummary>; truncated: boolean; tag?: string };

type SummarizeOptions = Readonly<{
  maxDepth?: number;
  maxKeys?: number;
  maxArrayItems?: number;
}>;

const DEFAULTS: Required<SummarizeOptions> = {
  maxDepth: 4,
  maxKeys: 20,
  maxArrayItems: 20,
};

function objectTag(value: unknown): string {
  try {
    return Object.prototype.toString.call(value);
  } catch {
    return '[object Unknown]';
  }
}

export function summarizeValueShapeForLog(value: unknown, options?: SummarizeOptions): ValueShapeSummary {
  const opts = { ...DEFAULTS, ...(options ?? {}) };
  const visited = new WeakSet<object>();

  const summarize = (input: unknown, depth: number): ValueShapeSummary => {
    if (input === null) return { kind: 'null' };
    if (input === undefined) return { kind: 'undefined' };

    if (typeof input === 'string') return { kind: 'string', length: input.length };
    const t = typeof input;
    if (t === 'number') return { kind: 'number' };
    if (t === 'boolean') return { kind: 'boolean' };
    if (t === 'bigint') return { kind: 'bigint' };
    if (t === 'symbol') return { kind: 'symbol' };
    if (t === 'function') return { kind: 'function' };

    // objects
    if (depth >= opts.maxDepth) {
      return { kind: 'truncated', type: objectTag(input) };
    }

    if (input instanceof Date) {
      return { kind: 'date', iso: input.toISOString() };
    }

    if (input instanceof Error) {
      const message = typeof input.message === 'string' ? input.message : '';
      return { kind: 'error', name: input.name || 'Error', messageLength: message.length };
    }

    if (typeof input !== 'object' || input === null) {
      return { kind: 'truncated', type: String(t) };
    }

    if (visited.has(input)) return { kind: 'circular' };
    visited.add(input);

    if (Array.isArray(input)) {
      const items = input.slice(0, opts.maxArrayItems).map((v) => summarize(v, depth + 1));
      return {
        kind: 'array',
        length: input.length,
        items,
        truncated: input.length > opts.maxArrayItems,
      };
    }

    const entries = Object.entries(input as Record<string, unknown>);
    const keys = entries.map(([k]) => k).sort();
    const limitedKeys = keys.slice(0, opts.maxKeys);
    const fields: Record<string, ValueShapeSummary> = {};
    for (const key of limitedKeys) {
      fields[key] = summarize((input as any)[key], depth + 1);
    }

    return {
      kind: 'object',
      keys: limitedKeys,
      fields,
      truncated: keys.length > opts.maxKeys,
      tag: objectTag(input),
    };
  };

  return summarize(value, 0);
}

type SignatureOptions = Readonly<{
  maxDepth?: number;
  maxKeys?: number;
  maxArrayItems?: number;
}>;

const SIGNATURE_DEFAULTS: Required<SignatureOptions> = {
  maxDepth: 3,
  maxKeys: 30,
  maxArrayItems: 10,
};

function buildValueShapeSignature(value: unknown, options?: SignatureOptions): string {
  const opts = { ...SIGNATURE_DEFAULTS, ...(options ?? {}) };
  const visited = new WeakSet<object>();

  const walk = (input: unknown, depth: number): string => {
    if (input === null) return 'null';
    if (input === undefined) return 'undefined';
    const t = typeof input;
    if (t !== 'object') return t;

    if (depth >= opts.maxDepth) return objectTag(input);
    if (!input) return 'null';
    if (input instanceof Date) return 'date';
    if (input instanceof Error) return `error:${input.name || 'Error'}`;

    if (visited.has(input as object)) return 'circular';
    visited.add(input as object);

    if (Array.isArray(input)) {
      const items = input.slice(0, opts.maxArrayItems).map((v) => walk(v, depth + 1));
      return `array[${items.join(',')}]`;
    }

    const keys = Object.keys(input as Record<string, unknown>).sort().slice(0, opts.maxKeys);
    const parts = keys.map((k) => `${k}:${walk((input as any)[k], depth + 1)}`);
    return `object{${parts.join(',')}}`;
  };

  return walk(value, 0);
}

type LoggerSubset = Readonly<{ debug: (message: string, ...args: unknown[]) => void }>;

export function createEventShapeLoggerForLog(params: Readonly<{
  logger: LoggerSubset;
  scope: string;
  maxEntries?: number;
}>): Readonly<{
  log: (label: string, value: unknown) => void;
}> {
  const cache = new LruSet(params.maxEntries ?? 200);

  return {
    log: (label: string, value: unknown) => {
      const signature = `${params.scope}:${label}:${buildValueShapeSignature(value)}`;
      if (cache.has(signature)) return;
      cache.add(signature);
      params.logger.debug(`[shape:${params.scope}] ${label}`, summarizeValueShapeForLog(value));
    },
  };
}
