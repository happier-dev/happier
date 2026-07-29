import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const scriptPath = resolve(repoRoot, 'scripts/pipeline/github/publish-release.mjs');
const targetSha = '0123456789abcdef0123456789abcdef01234567';

function executable(path, source) {
  writeFileSync(path, source, { encoding: 'utf8', mode: 0o755 });
  chmodSync(path, 0o755);
}

test('immutable publication refuses to overwrite different remote bytes and retries only missing assets', () => {
  const root = mkdtempSync(join(tmpdir(), 'immutable-release-'));
  const bin = join(root, 'bin');
  const local = join(root, 'local');
  const remote = join(root, 'remote');
  const log = join(root, 'gh.log');
  mkdirSync(bin);
  mkdirSync(local);
  mkdirSync(remote);
  writeFileSync(join(local, 'archive.tar.gz'), 'authorized bytes\n');
  writeFileSync(join(local, 'checksums.txt'), 'checksums\n');
  writeFileSync(join(remote, 'archive.tar.gz'), 'different bytes\n');
  writeFileSync(log, '');
  executable(join(bin, 'gh'), `#!/bin/sh
set -eu
echo "gh $*" >> ${JSON.stringify(log)}
if [ "$1" = api ]; then printf '%s\n' ${JSON.stringify(targetSha)}; exit 0; fi
if [ "$1" = release ] && [ "$2" = view ]; then
  if echo "$*" | grep -q -- "--json assets"; then
    for file in ${JSON.stringify(remote)}/*; do [ -e "$file" ] && basename "$file"; done
  fi
  exit 0
fi
if [ "$1" = release ] && [ "$2" = download ]; then
  pattern=""; destination=""
  while [ "$#" -gt 0 ]; do
    case "$1" in --pattern) pattern="$2"; shift 2 ;; --dir) destination="$2"; shift 2 ;; *) shift ;; esac
  done
  mkdir -p "$destination"; cp ${JSON.stringify(remote)}/"$pattern" "$destination"/; exit 0
fi
if [ "$1" = release ] && [ "$2" = upload ]; then cp "$4" ${JSON.stringify(remote)}/"$(basename "$4")"; exit 0; fi
exit 0
`);
  const args = [
    scriptPath,
    '--tag', 'cli-v1.2.3-preview.4',
    '--title', 'Happier CLI v1.2.3-preview.4',
    '--target-sha', targetSha,
    '--prerelease', 'true',
    '--rolling-tag', 'false',
    '--generate-notes', 'true',
    '--assets-dir', local,
    '--clobber', 'false',
    '--prune-assets', 'false',
  ];
  const env = { ...process.env, GH_REPO: 'test/test', PATH: `${bin}:${process.env.PATH ?? ''}` };
  try {
    const mismatch = spawnSync(process.execPath, args, { cwd: repoRoot, env, encoding: 'utf8' });
    assert.notEqual(mismatch.status, 0);
    assert.match(`${mismatch.stdout}\n${mismatch.stderr}`, /immutable|different|mismatch/i);
    assert.doesNotMatch(readFileSync(log, 'utf8'), /release upload/);

    writeFileSync(join(remote, 'archive.tar.gz'), 'authorized bytes\n');
    writeFileSync(log, '');
    execFileSync(process.execPath, args, { cwd: repoRoot, env, encoding: 'utf8' });
    const retryLog = readFileSync(log, 'utf8');
    assert.match(retryLog, /release upload cli-v1\.2\.3-preview\.4 .*checksums\.txt/);
    assert.doesNotMatch(retryLog, /release upload cli-v1\.2\.3-preview\.4 .*archive\.tar\.gz/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
