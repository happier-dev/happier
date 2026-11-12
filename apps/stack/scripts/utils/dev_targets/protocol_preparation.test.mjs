import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const entry = fileURLToPath(new URL('./native_execution_projection.mjs', import.meta.url));

for (const mode of ['live', 'artifact']) {
  test(`protocol preparation uses the target generator in ${mode} mode`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'hstack-protocol-target-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const packageRoot = join(root, 'packages/protocol');
    await mkdir(join(packageRoot, 'scripts'), { recursive: true });
    await mkdir(join(packageRoot, 'src'));
    const manifest = '{"name":"target-protocol","exports":{"./historical":"./src/index.ts"}}\n';
    await writeFile(join(packageRoot, 'package.json'), manifest);
    await writeFile(join(packageRoot, 'tsconfig.json'), '{"compilerOptions":{"target":"ES2022"},"include":["src/**/*.ts"]}');
    await writeFile(join(packageRoot, 'src/index.ts'), 'export const target = true;');
    await writeFile(join(packageRoot, 'export-aliases.json'), '{}');
    await writeFile(join(packageRoot, 'scripts/generate-exports.mjs'), `
      import { writeFile } from 'node:fs/promises';
      import { delimiter, join } from 'node:path';
      export async function prepareProtocolExports({ packageRoot, publicationMode }) {
        await writeFile(join(packageRoot, 'target-generator.json'), JSON.stringify({ packageRoot, publicationMode }));
      }
    `);
    const result = spawnSync(process.execPath, [entry, '--prepare-protocol-exports', root,
      ...(mode === 'artifact' ? ['--artifact'] : [])], { encoding: 'utf8',
      env: { ...process.env, CI: '', HAPPIER_DEV_TARGET_EXECUTION: '', npm_lifecycle_event: '' } });
    assert.equal(result.status, 0, result.stderr);
    // The primary generator rewrites this valid manifest in live mode.
    assert.equal(await readFile(join(packageRoot, 'package.json'), 'utf8'), manifest);
    assert.deepEqual(JSON.parse(await readFile(join(packageRoot, 'target-generator.json'), 'utf8')),
      { packageRoot, publicationMode: mode });
  });
}

test('protocol preparation leaves a checkout without a generator unchanged', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-protocol-no-generator-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'packages/protocol');
  await mkdir(packageRoot, { recursive: true });
  const manifest = '{"exports":{"./historical":"./historical.js"}}\n';
  await writeFile(join(packageRoot, 'package.json'), manifest);
  const result = spawnSync(process.execPath, [entry, '--prepare-protocol-exports', root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(packageRoot, 'package.json'), 'utf8'), manifest);
});

// Only the external installer is replaced: dependency admission, readiness,
// publication and the target generator all run through their real owners.
test('cold sibling prepares generator dependencies and warm publication reuses them', {
  skip: process.platform === 'win32' ? 'POSIX installer executable fixture' : false,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-protocol-cold-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@12.14.0' }));
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  for (const name of ['stack', 'ui', 'server']) {
    await mkdir(join(root, 'apps', name), { recursive: true });
    await writeFile(join(root, 'apps', name, 'package.json'), '{}');
  }
  const protocol = join(root, 'packages/protocol');
  await mkdir(join(protocol, 'scripts'), { recursive: true });
  await writeFile(join(protocol, 'package.json'), '{"name":"@happier-dev/protocol","type":"module"}');
  await writeFile(join(protocol, 'scripts/generate-exports.mjs'), `
    import { writeFile } from 'node:fs/promises';
    import { ready } from 'generator-tool';
    export async function prepareProtocolExports({ packageRoot }) {
      await writeFile(packageRoot + '/prepared', String(ready));
    }
  `);
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'pnpm'), `#!${process.execPath}
    const fs = require('node:fs');
    if (process.argv.includes('--version')) { console.log('12.14.0'); process.exit(0); }
    if (!process.argv.includes('install')) process.exit(8);
    const dep = process.cwd() + '/node_modules/generator-tool';
    if (fs.existsSync(dep)) process.exit(27); // A warm reader must not reinstall.
    fs.mkdirSync(dep, { recursive: true });
    fs.writeFileSync(dep + '/package.json', JSON.stringify({type:'module',exports:'./index.js'}));
    fs.writeFileSync(dep + '/index.js', 'export const ready = true;');
  `);
  await chmod(join(bin, 'pnpm'), 0o755);
  const prepare = () => spawnSync(process.execPath, [entry, '--prepare-protocol-exports', root], {
    encoding: 'utf8', env: { ...process.env, PATH: bin + delimiter + process.env.PATH,
      CI: '', HAPPIER_DEV_TARGET_EXECUTION: '', HAPPIER_STACK_SKIP_REFRESH_DEPS: '',
      HAPPIER_STACK_DISABLE_REFRESH_DEPS: '', npm_execpath: '', npm_lifecycle_event: '' },
  });
  for (const state of ['cold', 'warm']) {
    const result = prepare();
    assert.equal(result.status, 0, state + ': ' + result.stderr);
    assert.equal(await readFile(join(protocol, 'prepared'), 'utf8'), 'true');
  }
});
