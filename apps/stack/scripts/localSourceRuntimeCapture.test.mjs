// @happier-test-preparation source
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gitBlobId } from '../bin/localToolingPackagePin.mjs';
import { sourceBuildNodeArgs } from './utils/proc/sourceBuildNodeArgs.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

test('captured source tools transform pinned TypeScript after an inherited checkout loader', async t => {
  const capture = await mkdtemp(join(tmpdir(), 'happier-captured-source-loader-'));
  t.after(() => rm(capture, { recursive: true, force: true }));
  await cp(join(repo, 'packages/cli-common'), join(capture, 'packages/cli-common'), {
    recursive: true,
    filter: path => path === join(repo, 'packages/cli-common')
      || dirname(path) === join(repo, 'packages/cli-common') && /\.(?:mjs|cjs|json)$/u.test(path),
  });
  const pinPath = 'apps/stack/bin/localToolingPackagePin.mjs';
  await mkdir(dirname(join(capture, pinPath)), { recursive: true });
  await cp(join(repo, pinPath), join(capture, pinPath));
  await symlink(join(repo, 'node_modules'), join(capture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const leaf = 'packages/protocol/src/definition.ts';
  await mkdir(dirname(join(capture, leaf)), { recursive: true });
  await writeFile(join(capture, 'packages/protocol/package.json'), '{"type":"module"}');
  await writeFile(join(capture, leaf), 'export const value: string = "checkout";');
  const committed = Buffer.from('type DefinitionLifetime = { value: string };\nexport const value: DefinitionLifetime = { value: "committed" };');
  const id = gitBlobId(committed);
  const manifest = JSON.stringify({ version: 3, blobs: { [leaf]: id } });
  const digest = createHash('sha256').update(manifest).digest('hex');
  const pin = join(capture, '.happier-tooling-pin');
  await mkdir(join(pin, 'blobs'), { recursive: true });
  await mkdir(join(pin, 'manifests'));
  await writeFile(join(pin, 'blobs', id), committed);
  await writeFile(join(pin, 'manifests', `${digest}.json`), manifest);
  await writeFile(join(pin, 'manifest.json'), JSON.stringify({ version: 3, manifest: digest }));
  const entry = join(capture, 'scripts/workspaces/build-ui.mjs');
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, `import { value } from '../../${leaf}'; process.stdout.write(value.value);`);
  for (const inherited of [false, true]) {
    const result = spawnSync(process.execPath, sourceBuildNodeArgs({ repoDir: capture, scriptPath: entry }), {
      cwd: capture, encoding: 'utf8',
      env: { ...process.env, HAPPIER_STACK_TOOLING_PACKAGES: 'pinned',
        NODE_OPTIONS: inherited ? `--import=${pathToFileURL(join(repo, 'packages/cli-common/registerSourceRuntime.mjs')).href}` : '' },
    });
    assert.equal(result.status, 0, `inherited=${inherited}\n${result.stderr}`);
    assert.equal(result.stdout, 'committed');
  }
});
