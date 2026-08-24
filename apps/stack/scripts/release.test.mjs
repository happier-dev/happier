import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..', '..');
const releaseScript = join(scriptDir, 'release.mjs');

test('legacy Stack release entrypoint cannot independently version or publish npm', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-stack-release-entrypoint-'));
  const binDir = join(fixtureRoot, 'bin');
  const npmName = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npmStub = join(binDir, npmName);
  try {
    await mkdir(binDir);
    await writeFile(
      npmStub,
      process.platform === 'win32'
        ? '@echo off\r\necho FAKE_NPM_INVOKED 1>&2\r\nexit /b 91\r\n'
        : '#!/bin/sh\necho FAKE_NPM_INVOKED >&2\nexit 91\n',
      { mode: 0o755 },
    );

    const result = spawnSync(process.execPath, [releaseScript, 'patch', '--no-git', '--dry-run'], {
      cwd: repoRoot,
      env: { ...process.env, PATH: `${binDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });

    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /scripts\/pipeline\/run\.mjs npm-release/u);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /FAKE_NPM_INVOKED/u);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
