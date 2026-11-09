import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const directory = dirname(fileURLToPath(import.meta.url));

/** Bundle the fixture against the public browser SDK source entry. */
export function buildLivePageBundle() {
  return build({
    absWorkingDir: directory,
    entryPoints: [resolve(directory, 'live.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    conditions: ['happier-source', 'browser'],
    alias: {
      '@happier-dev/sdk': resolve(directory, '../../sdk/src/index.public.ts'),
    },
    plugins: [{
      name: 'happier-fixture-browser-http',
      setup(context) {
        context.onResolve({ filter: /^#http$/ }, () => ({
          path: resolve(directory, '../../sdk/src/http/fetchHttp.ts'),
        }));
      },
    }],
    metafile: true,
  });
}
