import { realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

export function createRealpathNormalizer(): (value: string) => string {
  const cache = new Map<string, string>();

  return (value: string) => {
    const resolved = resolvePath(value);
    const cached = cache.get(resolved);
    if (cached) return cached;

    let normalized = resolved;
    try {
      normalized = realpathSync(resolved);
    } catch {
      // keep resolved
    }

    cache.set(resolved, normalized);
    return normalized;
  };
}
