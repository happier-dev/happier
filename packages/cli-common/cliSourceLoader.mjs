import { fileURLToPath } from 'node:url';

/** Tools-only CLI source loading. Keep registration outside runtime entry graphs.
 * Callers own the namespace lifetime; tsx and the existing workspace hook retain
 * resolution authority independently of the importing tool's entry/cwd. */
export async function createCliSourceLoader(namespace) {
  await import('./registerSourceRuntime.mjs');
  const { register } = await import('tsx/esm/api');
  return register({ namespace,
    tsconfig: fileURLToPath(new URL('../../apps/cli/tsconfig.runtime.json', import.meta.url)),
  });
}
