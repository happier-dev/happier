export function getFlagValue({ argv, kv, flag }) {
  const k = String(flag ?? '').trim();
  if (!k) return undefined;

  const fromKv = kv?.get?.(k);
  if (fromKv !== undefined) {
    return fromKv;
  }

  // Support space-separated args like: --platform android
  // Prefer the last occurrence (typical CLI behavior).
  const args = Array.isArray(argv) ? argv : [];
  for (let i = args.length - 2; i >= 0; i -= 1) {
    if (args[i] !== k) continue;
    const next = args[i + 1];
    if (typeof next !== 'string') return undefined;
    if (next.startsWith('--')) return undefined;
    return next;
  }

  return undefined;
}

