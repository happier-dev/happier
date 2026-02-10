import { rmDirSafeSync } from './rmDirSafe.mjs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveDistDir(argv = process.argv) {
  const candidate = String(argv?.[2] ?? '').trim();
  if (!candidate || candidate.startsWith('-')) return 'dist';
  if (isAbsolute(candidate)) return 'dist';
  const segments = candidate.split(/[\\/]+/g).filter(Boolean);
  if (segments.includes('.')) return 'dist';
  if (segments.includes('..')) return 'dist';
  return candidate;
}

export function main(argv = process.argv) {
  const dir = resolveDistDir(argv);
  rmDirSafeSync(dir, {
    // Local dev can run with other watchers rebuilding dist; give ourselves a bit of headroom.
    retries: 25,
    delayMs: 20,
  });
}

const isEntrypoint = (() => {
  const arg = typeof process.argv?.[1] === 'string' ? process.argv[1] : '';
  if (!arg) return false;
  return resolve(arg) === resolve(fileURLToPath(import.meta.url));
})();

if (isEntrypoint) {
  main(process.argv);
}
