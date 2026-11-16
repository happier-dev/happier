import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { build } from 'esbuild';

import { SOURCE_RUNTIME_COMMONJS_BANNER, SOURCE_RUNTIME_COMMONJS_DEFINE, stripUnusedSourceRuntimeBanners } from '../sourceRuntimeEntries.mjs';

describe('source runtime CommonJS banner', () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the CommonJS banner only in chunks that read require, __filename or __dirname', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-runtime-banner-'));
    dirs.push(dir);
    const out = join(dir, 'out');
    for (const [name, code] of Object.entries({
      'shared.js': 'export const shared = () => 1;\n',
      'usesRequire.js': "import { shared } from './shared.js';\nexport const run = () => shared() + require('node:path').sep.length;\n",
      'usesDirname.js': "import { shared } from './shared.js';\nexport const run = () => shared() + (typeof __dirname === 'string' ? 1 : 0);\n",
      'plain.js': "import { shared } from './shared.js';\nexport const run = () => shared();\n",
    })) {
      writeFileSync(join(dir, name), code);
    }
    // The emitters' shape: split ESM for Node with the shared banner and defines.
    const result = await build({
      absWorkingDir: dir,
      entryPoints: ['usesRequire.js', 'usesDirname.js', 'plain.js'].map((name) => join(dir, name)),
      outdir: out,
      bundle: true,
      splitting: true,
      format: 'esm',
      platform: 'node',
      metafile: true,
      logLevel: 'silent',
      banner: { js: SOURCE_RUNTIME_COMMONJS_BANNER },
      define: SOURCE_RUNTIME_COMMONJS_DEFINE,
    });
    const outputs = Object.keys(result.metafile.outputs).map((file) => join(dir, file));

    await stripUnusedSourceRuntimeBanners(outputs);

    const files = readdirSync(out);
    const withBanner = files.filter((file) => readFileSync(join(out, file), 'utf8').includes('__sourceCreateRequire('));
    // esbuild routes `require` through its `__require` helper, emitted in the shared chunk: that chunk keeps
    // its banner, the entry calling the helper does not need one.
    expect(files).toHaveLength(4);
    expect(withBanner).toHaveLength(2);
    expect(withBanner).toContain('usesDirname.js');
    expect(withBanner).not.toContain('plain.js');
    expect(withBanner).not.toContain('usesRequire.js');
    for (const [file, expected] of [['usesRequire.js', 2], ['usesDirname.js', 2], ['plain.js', 1]]) {
      const module = await import(pathToFileURL(join(out, file)).href);
      expect(module.run()).toBe(expected);
    }
  });
});
