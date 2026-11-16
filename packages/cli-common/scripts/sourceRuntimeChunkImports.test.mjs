import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { build } from 'esbuild';

import {
  dropRedundantSourceRuntimeChunkImports, SOURCE_RUNTIME_COMMONJS_BANNER, SOURCE_RUNTIME_COMMONJS_DEFINE, SOURCE_RUNTIME_OUTPUT_OPTIONS,
  stripUnusedSourceRuntimeBanners,
} from '../sourceRuntimeEntries.mjs';

const BARE_RELATIVE_IMPORT = /import\s*["']\.\.?\/[^"']+["']\s*;?/g;

describe('source runtime chunk preload imports', () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('drops bare chunk imports an earlier import already reached, keeping evaluation order and columns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-runtime-chunk-imports-'));
    dirs.push(dir);
    const out = join(dir, 'out');
    // Layered shared chunks reached from entries and lazy chunks: esbuild hoists a bare import of every
    // chunk an entry's graph reaches, even when an earlier import of that entry already reaches it.
    const files = {
      'log.js': "export const order = [];\nexport const mark = (name) => { order.push(name); };\n",
      'leaf.js': "import { mark } from './log.js';\nmark('leaf');\nexport const leaf = () => 'l';\n",
      'mid.js': "import { mark } from './log.js';\nimport { leaf } from './leaf.js';\nmark('mid');\nexport const mid = () => `m${leaf()}`;\n",
      'top.js': "import { mark } from './log.js';\nimport { mid } from './mid.js';\nmark('top');\nexport const top = () => `t${mid()}`;\n",
      'one.js': "import { top } from './top.js';\nimport { order } from './log.js';\nexport const run = async () => [top(), (await import('./two.js')).run(), [...order]];\n",
      'two.js': "import { mid } from './mid.js';\nimport { mark } from './log.js';\nmark('two');\nexport const run = () => mid();\n",
      'three.js': "import { leaf } from './leaf.js';\nimport { order } from './log.js';\nexport const run = async () => [leaf(), (await import('./two.js')).run(), (await import('./four.js')).run(), [...order]];\n",
      'four.js': "import { top } from './top.js';\nexport const run = () => top() + (typeof __dirname === 'string' ? '' : '!');\n",
    };
    for (const [name, code] of Object.entries(files)) writeFileSync(join(dir, name), code);
    const result = await build({
      absWorkingDir: dir,
      entryPoints: ['one.js', 'three.js'].map((name) => join(dir, name)),
      outdir: out,
      bundle: true,
      splitting: true,
      format: 'esm',
      platform: 'node',
      metafile: true,
      logLevel: 'silent',
      ...SOURCE_RUNTIME_OUTPUT_OPTIONS,
      // The emitters' shape: the CommonJS banner stays on chunks that read __dirname (four.js here).
      banner: { js: SOURCE_RUNTIME_COMMONJS_BANNER },
      define: SOURCE_RUNTIME_COMMONJS_DEFINE,
    });
    const outputs = Object.keys(result.metafile.outputs).map((file) => join(dir, file));
    await stripUnusedSourceRuntimeBanners(outputs);
    const read = () => Object.fromEntries(readdirSync(out).map((file) => [file, readFileSync(join(out, file), 'utf8')]));
    const before = read();
    const bareBefore = Object.values(before).reduce((sum, code) => sum + (code.match(BARE_RELATIVE_IMPORT) ?? []).length, 0);
    // The unmodified graph runs from its own copy: an ESM URL evaluates once per process.
    cpSync(out, join(dir, 'before'), { recursive: true });
    const expected = [];
    for (const entry of ['one.js', 'three.js']) expected.push(await (await import(pathToFileURL(join(dir, 'before', entry)).href)).run());

    const dropped = await dropRedundantSourceRuntimeChunkImports(outputs);

    const after = read();
    const bareAfter = Object.values(after).reduce((sum, code) => sum + (code.match(BARE_RELATIVE_IMPORT) ?? []).length, 0);
    expect(bareBefore).toBeGreaterThan(0);
    expect(dropped).toBeGreaterThan(0);
    expect(bareAfter).toBe(bareBefore - dropped);
    // Every bare import in this graph is reached by an earlier import of its chunk, banner or not.
    const four = Object.keys(after).find((file) => file.startsWith('four-'));
    expect(before[four]).toContain(SOURCE_RUNTIME_COMMONJS_BANNER);
    expect(after[four].match(BARE_RELATIVE_IMPORT)).toBeNull();
    expect(bareAfter).toBe(0);
    for (const [file, code] of Object.entries(after)) {
      // Removed statements become spaces, so every line and column still matches a source map.
      expect(code.length, file).toBe(before[file].length);
      expect(code.split('\n').length, file).toBe(before[file].split('\n').length);
    }
    const actual = [];
    for (const entry of ['one.js', 'three.js']) actual.push(await (await import(pathToFileURL(join(out, entry)).href)).run());
    expect(actual).toEqual(expected);
  });
});
