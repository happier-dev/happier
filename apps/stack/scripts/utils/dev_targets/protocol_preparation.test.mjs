import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      import { join } from 'node:path';
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
