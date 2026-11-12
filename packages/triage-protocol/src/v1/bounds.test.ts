import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

import { MAX_TRIAGE_TEXT_UTF8_BYTES_V1 } from './bounds.js';
import { deriveTriageListFieldUtf8BytesV1 } from './listFieldAllocation.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

// The daemon, server, runners and UI import this Protocol. Deriving the shared field
// allocation builds two maximal list values (over 1 GiB allocated in a runner start), so
// the derivation runs here, never at import.
it('keeps the list field allocation derivation out of the Protocol import graph', async () => {
  const { build } = createRequire(join(packageRoot, 'package.json'))('esbuild') as typeof import('esbuild');
  const entryPoint = 'src/v1/index.ts';
  const { metafile } = await build({
    absWorkingDir: packageRoot, entryPoints: [entryPoint], outdir: 'unused-triage-graph',
    platform: 'node', format: 'esm', bundle: true, write: false, metafile: true,
    conditions: ['happier-source'], packages: 'external', logLevel: 'silent',
  });
  const eager = new Set<string>();
  const pending = [entryPoint];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (eager.has(path)) continue;
    eager.add(path);
    for (const dependency of metafile!.inputs[path]?.imports ?? []) {
      if (!dependency.external && dependency.kind !== 'dynamic-import') pending.push(dependency.path);
    }
  }
  expect([...eager].filter(path => /listFieldAllocation|maximumEncodedValue/.test(path))).toEqual([]);
}, 240_000);

it('publishes the field allocation the shared list schemas derive', () => {
  // On a schema or envelope change, set TRIAGE_LIST_FIELD_UTF8_BYTES_V1 in bounds.ts to this value.
  expect(MAX_TRIAGE_TEXT_UTF8_BYTES_V1).toBe(deriveTriageListFieldUtf8BytesV1());
});
