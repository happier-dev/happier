import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOURCE_RUNTIME_OUTPUT_OPTIONS, assertSourceRuntimeCodeAscii } from './sourceRuntimeEntries.mjs';

const esbuild = createRequire(import.meta.url)('esbuild');

// esbuild's ASCII charset escapes strings and drops comments, but keeps regex
// literals verbatim; one such literal makes V8 hold the whole chunk as UTF-16.
test('refuses emitted code whose regular expression keeps a Unicode character, accepts its escaped form', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'source-runtime-ascii-'));
  try {
    const build = async (name, source) => {
      await writeFile(join(dir, `${name}.ts`), source);
      const result = await esbuild.build({ entryPoints: [join(dir, `${name}.ts`)], outdir: join(dir, 'out'), bundle: true,
        format: 'esm', platform: 'node', metafile: true, logLevel: 'silent', ...SOURCE_RUNTIME_OUTPUT_OPTIONS });
      return Object.keys(result.metafile.outputs).map(file => join(process.cwd(), file));
    };
    const literal = await build('literal', "// comment — dropped\nexport const label = 'Envoyé';\nexport const rule = /^[─━]+$/u;\n");
    await assert.rejects(assertSourceRuntimeCodeAscii(literal), error => error.message.includes('literal.js'));
    const escaped = await build('escaped', "// comment — dropped\nexport const label = 'Envoyé';\nexport const rule = /^[\\u2500\\u2501]+$/u;\n");
    await assertSourceRuntimeCodeAscii(escaped);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
