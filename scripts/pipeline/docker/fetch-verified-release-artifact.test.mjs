import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = new URL('../../..', import.meta.url).pathname;

test('fetch-verified-release-artifact verifies signed checksums and extracts one top-level payload', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'happier-docker-artifact-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const releaseDir = join(tmp, 'release', 'server-preview');
  const payloadDir = join(tmp, 'payload', 'happier-server-v1.2.3-linux-x64');
  const binDir = join(tmp, 'bin');
  const destDir = join(tmp, 'dest');
  mkdirSync(releaseDir, { recursive: true });
  mkdirSync(join(payloadDir, 'bin'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(payloadDir, 'bin', 'happier-server'), 'ok\n');
  writeFileSync(join(payloadDir, 'bin', '._happier-server'), 'appledouble metadata\n');

  const archiveName = 'happier-server-v1.2.3-linux-x64.tar.gz';
  const checksumsName = 'checksums-happier-server-v1.2.3.txt';
  execFileSync('tar', ['-czf', join(releaseDir, archiveName), '-C', join(tmp, 'payload'), 'happier-server-v1.2.3-linux-x64'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const sha = execFileSync('shasum', ['-a', '256', join(releaseDir, archiveName)], { encoding: 'utf8' }).trim().split(/\s+/)[0];
  writeFileSync(join(releaseDir, checksumsName), `${sha}  ${archiveName}\n`);
  writeFileSync(join(releaseDir, `${checksumsName}.minisig`), 'signature\n');
  writeFileSync(join(tmp, 'pubkey'), 'pubkey\n');

  const minisignLog = join(tmp, 'minisign.log');
  const minisignPath = join(binDir, 'minisign');
  writeFileSync(
    minisignPath,
    `#!/bin/sh
set -eu
echo "$@" >> "${minisignLog}"
exit 0
`,
  );
  chmodSync(minisignPath, 0o755);

  execFileSync(
    'sh',
    [
      join(repoRoot, 'scripts', 'pipeline', 'docker', 'fetch-verified-release-artifact.sh'),
      '--base-url',
      `file://${join(tmp, 'release')}`,
      '--release-tag',
      'server-preview',
      '--product',
      'happier-server',
      '--version',
      '1.2.3',
      '--os',
      'linux',
      '--arch',
      'x64',
      '--dest',
      destDir,
      '--pubkey',
      join(tmp, 'pubkey'),
    ],
    {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  assert.equal(readFileSync(join(destDir, 'bin', 'happier-server'), 'utf8'), 'ok\n');
  assert.equal(existsSync(join(destDir, 'bin', '._happier-server')), false);
  const minisignArgs = readFileSync(minisignLog, 'utf8');
  assert.match(minisignArgs, /-Vm/);
  assert.match(minisignArgs, /-x .*checksums-happier-server-v1\.2\.3\.txt\.minisig/);
  assert.match(minisignArgs, /-p .*pubkey/);
});
