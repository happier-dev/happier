import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

for (const stage of ['root', 'ui']) {
  test(`UI postinstall propagates a ${stage} patch failure before further preparation`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'happier-ui-patch-failure-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const ui = join(root, 'apps/ui');
    await mkdir(ui, { recursive: true });
    await cp(new URL('../', import.meta.url), join(ui, 'tools'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"private":true,"type":"module"}\n');
    await writeFile(join(root, 'yarn.lock'), '# fixture\n');
    await writeFile(join(ui, 'package.json'), '{"name":"@happier-dev/app"}\n');
    await mkdir(join(ui, 'patches'), { recursive: true });
    await writeFile(join(ui, 'patches/expo-router+55.0.10.patch'), 'boundary patch\n');
    for (const directory of [root, ui]) await mkdir(join(directory, 'node_modules/expo-router'), { recursive: true });
    const patchCli = join(root, 'node_modules/patch-package/dist/index.js');
    await mkdir(join(root, 'node_modules/patch-package/dist'), { recursive: true });
    const require = createRequire(import.meta.url);
    await symlink(join(require.resolve('esbuild/package.json'), '..'), join(root, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
    // Genuine third-party process boundary: patch-package reports errors but
    // defaults to success outside CI unless --error-on-fail is requested.
    await writeFile(patchCli, `import { writeFileSync } from 'node:fs';
if (process.cwd() === ${JSON.stringify(stage === 'root' ? root : ui)}) {
  console.error('**ERROR** Failed to apply patch for package expo-router');
  process.exit(process.argv.includes('--error-on-fail') ? 23 : 0);
}
if (process.cwd() === ${JSON.stringify(ui)}) writeFileSync(${JSON.stringify(join(root, 'next-stage'))}, 'started');
`);
    const result = spawnSync(process.execPath, [join(ui, 'tools/postinstall.mjs')], {
      cwd: ui, encoding: 'utf8', env: { ...process.env, CI: '', HAPPIER_UI_VENDOR_WEB_ASSETS: '0' },
    });
    assert.equal(result.status, 23, result.stderr);
    assert.match(result.stderr, /Failed to apply patch/);
    await assert.rejects(readFile(join(root, 'next-stage')), { code: 'ENOENT' });
  });
}
