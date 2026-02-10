import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

async function writePkgJson(dir, { name, version }) {
  await mkdir(dir, { recursive: true });
  const pkgPath = join(dir, 'package.json');
  await writeFile(pkgPath, `${JSON.stringify({ name, version }, null, 2)}\n`, 'utf8');
  return pkgPath;
}

async function readVersion(pkgPath) {
  const raw = await readFile(pkgPath, 'utf8');
  return String(JSON.parse(raw).version);
}

test('bump-version bumps server app and relay-server versions in sync', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-bump-version-server-'));

  const appPkg = await writePkgJson(join(dir, 'apps', 'server'), {
    name: '@happier-dev/server',
    version: '0.1.0',
  });
  const runnerPkg = await writePkgJson(join(dir, 'packages', 'relay'), {
    name: '@happier-dev/relay-server',
    version: '0.1.0',
  });

  const script = resolve(process.cwd(), 'scripts', 'release', 'bump-version.mjs');
  const res = spawnSync(process.execPath, [script, '--component', 'server', '--bump', 'patch'], {
    cwd: dir,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.equal(String(res.stdout).trim(), '0.1.1');
  assert.equal(await readVersion(appPkg), '0.1.1');
  assert.equal(await readVersion(runnerPkg), '0.1.1');
});

test('bump-version rejects server version bumps when app and relay-server versions are out of sync', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-bump-version-server-mismatch-'));

  await writePkgJson(join(dir, 'apps', 'server'), {
    name: '@happier-dev/server',
    version: '0.1.0',
  });
  await writePkgJson(join(dir, 'packages', 'relay'), {
    name: '@happier-dev/relay-server',
    version: '0.2.0',
  });

  const script = resolve(process.cwd(), 'scripts', 'release', 'bump-version.mjs');
  const res = spawnSync(process.execPath, [script, '--component', 'server', '--bump', 'patch'], {
    cwd: dir,
    encoding: 'utf8',
  });

  assert.notEqual(res.status, 0);
  assert.match(String(res.stderr), /server app and relay-server versions must match/i);
});
