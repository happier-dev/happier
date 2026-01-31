export function parseArgs(argv) {
  const flags = new Set();
  const kv = new Map();
  for (const raw of argv) {
    if (!raw.startsWith('--')) {
      continue;
    }
    const [k, v] = raw.split('=', 2);
    if (v === undefined) {
      flags.add(k);
    } else {
      kv.set(k, v);
    }
  }
  return { flags, kv };
}

