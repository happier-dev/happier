export function parseOptionalInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

// Small deterministic PRNG for chaos tests.
// Returns floats in [0, 1).
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomIntInclusive(rng: () => number, min: number, max: number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
    throw new Error(`Invalid int range: [${min}, ${max}]`);
  }
  const span = max - min + 1;
  return min + Math.floor(rng() * span);
}

export function pickOne<T>(rng: () => number, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pickOne called with empty array');
  return items[Math.floor(rng() * items.length)]!;
}

