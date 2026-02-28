export class LruSet {
  private readonly max: number;
  private readonly map = new Map<string, true>();

  constructor(max: number) {
    this.max = Math.max(0, Math.floor(max));
  }

  get size(): number {
    return this.map.size;
  }

  has(value: string): boolean {
    return this.map.has(value);
  }

  add(value: string): void {
    if (this.max === 0) return;
    if (this.map.has(value)) {
      this.map.delete(value);
    }
    this.map.set(value, true);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (!oldest) break;
      this.map.delete(oldest);
    }
  }

  delete(value: string): void {
    this.map.delete(value);
  }

  clear(): void {
    this.map.clear();
  }
}

export function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, maxKeys: number): void {
  const limit = Math.max(0, Math.floor(maxKeys));
  if (map.has(key)) {
    map.delete(key); // refresh insertion order
  }
  map.set(key, value);
  if (limit === 0) {
    map.clear();
    return;
  }
  while (map.size > limit) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

