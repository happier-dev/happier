import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

async function writePackage(dir, name, version) {
  await mkdir(dir, { recursive: true });
  const packageJson = join(dir, 'package.json');
  await writeFile(packageJson, `${JSON.stringify({ name, version }, null, 2)}\n`, 'utf8');
  return packageJson;
}

async function versionAt(packageJson) {
  return JSON.parse(await readFile(packageJson, 'utf8')).version;
}

test('bump-version bumps the plugin SDK lockstep pair from the one canonical component', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-bump-plugin-sdk-'));
  const pluginSdk = await writePackage(join(root, 'packages', 'plugin-sdk'), '@happier-dev/plugin-sdk', '0.0.0');
  const pluginUi = await writePackage(join(root, 'packages', 'plugin-ui'), '@happier-dev/plugin-ui', '0.0.0');
  const script = resolve(process.cwd(), 'scripts', 'pipeline', 'release', 'bump-version.mjs');

  const result = spawnSync(process.execPath, [script, '--component', 'plugin_sdk', '--bump', 'minor'], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(String(result.stdout).trim(), '0.1.0');
  assert.equal(await versionAt(pluginSdk), '0.1.0');
  assert.equal(await versionAt(pluginUi), '0.1.0');
});

test('bump-version refuses to split the plugin SDK lockstep pair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-bump-plugin-sdk-mismatch-'));
  await writePackage(join(root, 'packages', 'plugin-sdk'), '@happier-dev/plugin-sdk', '0.1.0');
  await writePackage(join(root, 'packages', 'plugin-ui'), '@happier-dev/plugin-ui', '0.2.0');
  const script = resolve(process.cwd(), 'scripts', 'pipeline', 'release', 'bump-version.mjs');

  const result = spawnSync(process.execPath, [script, '--component', 'plugin_sdk', '--bump', 'patch'], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(String(result.stderr), /plugin-sdk and plugin-ui versions must match/i);
});
