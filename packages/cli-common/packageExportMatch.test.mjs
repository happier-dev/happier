import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import exportMatch from './packageExportMatch.cjs';

const { matchPackageExport, substitutePackageExportTarget } = exportMatch;
const map = {
  '.': { default: './src/index.ts' },
  './*': { default: './src/*.ts' },
  './*.test': null,
  './account/*': { default: './src/acct/*.ts' },
  './home': { default: './src/home/index.ts' },
};

// The repository resolvers must pick exactly the target Node picks for the same map.
test('selects the same export key as Node for exact, pattern, longer-prefix and excluded subpaths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'export-match-'));
  try {
    const pkg = join(dir, 'node_modules', 'pkg');
    for (const file of ['src/index.ts', 'src/a/b.ts', 'src/acct/x.ts', 'src/home/index.ts', 'src/home.ts', 'src/z.test.ts']) {
      await mkdir(join(pkg, file, '..'), { recursive: true });
      await writeFile(join(pkg, file), '');
    }
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'pkg', exports: map }));
    const require = createRequire(pathToFileURL(join(dir, 'index.js')));
    for (const subpath of ['.', './a/b', './account/x', './home', './z.test']) {
      const specifier = subpath === '.' ? 'pkg' : `pkg/${subpath.slice(2)}`;
      let nodeTarget = null;
      try { nodeTarget = './' + relative(pkg, require.resolve(specifier)).split(sep).join('/'); } catch {}
      const match = matchPackageExport(map, subpath);
      const ours = match ? substitutePackageExportTarget(match.declaration?.default ?? null, match.replacement) : null;
      assert.equal(ours, nodeTarget, subpath);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('treats a root conditional object as the "." export', () => {
  assert.deepEqual(matchPackageExport({ import: './a.js' }, '.'), { declaration: { import: './a.js' } });
  assert.equal(matchPackageExport({ import: './a.js' }, './x'), null);
});
