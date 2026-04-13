import { gethstackSpaceSeparatedValueFlags } from './cli_registry.mjs';

const SPACE_SEPARATED_VALUE_FLAGS = gethstackSpaceSeparatedValueFlags();

function shouldConsumeNextTokenAsValue(flag, nextToken) {
  if (!SPACE_SEPARATED_VALUE_FLAGS.has(flag)) return false;
  if (typeof nextToken !== 'string' || nextToken.length === 0) return false;
  return !nextToken.startsWith('-');
}

export function parseArgs(argv) {
  const flags = new Set();
  const kv = new Map();
  const args = Array.isArray(argv) ? argv.map(String) : [];

  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    if (raw === '--') {
      continue;
    }
    if (!raw.startsWith('--')) {
      continue;
    }

    const [key, value] = raw.split('=', 2);
    if (value === undefined) {
      const next = args[index + 1];
      if (shouldConsumeNextTokenAsValue(key, next)) {
        kv.set(key, next);
        index += 1;
        continue;
      }
      flags.add(key);
      continue;
    }

    kv.set(key, value);
  }

  return { flags, kv };
}
