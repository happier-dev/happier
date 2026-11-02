import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const scriptPath = resolve(repoRoot, 'scripts/pipeline/github/publish-release.mjs');
const targetSha = '0123456789abcdef0123456789abcdef01234567';

function writeExecutable(path, source) {
  writeFileSync(path, source, { encoding: 'utf8', mode: 0o755 });
  chmodSync(path, 0o755);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'immutable-release-'));
  const bin = join(root, 'bin');
  const local = join(root, 'local');
  const remote = join(root, 'remote');
  mkdirSync(bin);
  mkdirSync(local);
  mkdirSync(remote);
  writeFileSync(join(local, 'archive.tar.gz'), 'authorized bytes\n');
  writeFileSync(join(local, 'checksums.txt'), 'checksums\n');
  writeFileSync(join(remote, 'archive.tar.gz'), 'different bytes\n');
  const log = join(root, 'gh.log');
  const state = join(root, 'release.json');
  writeFileSync(state, JSON.stringify({ draft: true }));
  writeFileSync(log, '');
  writeExecutable(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const remote = ${JSON.stringify(remote)};
const stateFile = ${JSON.stringify(state)};
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = (value) => fs.writeFileSync(stateFile, JSON.stringify(value));
fs.appendFileSync(${JSON.stringify(log)}, 'gh ' + args.join(' ') + '\\n');
if (args[0] === 'api') {
  console.log(${JSON.stringify(targetSha)});
} else if (args[1] === 'view') {
  if (!state) process.exit(1);
  if (args.includes('isDraft')) console.log(state.draft);
  if (args.includes('assets')) console.log(fs.readdirSync(remote).join('\\n'));
} else if (args[1] === 'create') {
  if (state) throw new Error('release already exists');
  save({ draft: args.includes('--draft') });
} else if (args[1] === 'download') {
  const name = args[args.indexOf('--pattern') + 1];
  const destination = args[args.indexOf('--dir') + 1];
  fs.copyFileSync(path.join(remote, name), path.join(destination, name));
} else if (args[1] === 'upload') {
  const name = path.basename(args[3]);
  if (name === process.env.FAIL_UPLOAD) throw new Error('upload rejected');
  fs.copyFileSync(args[3], path.join(remote, name));
  if (name === process.env.CORRUPT_UPLOAD) fs.writeFileSync(path.join(remote, name), 'corrupted');
} else if (args[1] === 'edit' && args.includes('--draft=false')) {
  save({ draft: false });
} else {
  throw new Error('Unexpected gh call: ' + args.join(' '));
}
`,
  );
  return { root, bin, local, remote, log, state };
}

function args(local) {
  return [
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
}

test('an existing immutable draft rejects different bytes and a retry only fills missing assets', () => {
  const testFixture = fixture();
  const env = {
    ...process.env,
    GH_REPO: 'test/test',
    PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`,
  };
  try {
    const mismatched = spawnSync(process.execPath, args(testFixture.local), {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });
    assert.notEqual(mismatched.status, 0);
    assert.match(`${mismatched.stdout}\n${mismatched.stderr}`, /immutable|different|mismatch/i);
    assert.doesNotMatch(readFileSync(testFixture.log, 'utf8'), /release upload/);

    writeFileSync(join(testFixture.remote, 'archive.tar.gz'), 'authorized bytes\n');
    writeFileSync(testFixture.log, '');
    execFileSync(process.execPath, args(testFixture.local), {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });
    const retryLog = readFileSync(testFixture.log, 'utf8');
    assert.match(retryLog, /release upload cli-v1\.2\.3-preview\.4 .*checksums\.txt/);
    assert.doesNotMatch(retryLog, /release upload cli-v1\.2\.3-preview\.4 .*archive\.tar\.gz/);
    assert.equal(readFileSync(join(testFixture.remote, basename('archive.tar.gz')), 'utf8'), 'authorized bytes\n');
    assert.equal(readFileSync(join(testFixture.remote, basename('checksums.txt')), 'utf8'), 'checksums\n');
  } finally {
    rmSync(testFixture.root, { recursive: true, force: true });
  }
});

for (const failure of ['FAIL_UPLOAD', 'CORRUPT_UPLOAD']) {
  test(`immutable publication stays draft through ${failure} and resumes before publishing once`, () => {
    const f = fixture();
    const env = { ...process.env, GH_REPO: 'test/test', PATH: `${f.bin}:${process.env.PATH ?? ''}` };
    try {
      writeFileSync(f.state, 'null');
      rmSync(join(f.remote, 'archive.tar.gz'));
      const failed = spawnSync(process.execPath, args(f.local), {
        cwd: repoRoot, env: { ...env, [failure]: 'checksums.txt' }, encoding: 'utf8',
      });
      assert.notEqual(failed.status, 0);
      assert.equal(JSON.parse(readFileSync(f.state, 'utf8')).draft, true);
      assert.doesNotMatch(readFileSync(f.log, 'utf8'), /release edit/);
      if (failure === 'CORRUPT_UPLOAD') rmSync(join(f.remote, 'checksums.txt'));
      execFileSync(process.execPath, args(f.local), { cwd: repoRoot, env, encoding: 'utf8' });
      assert.equal(JSON.parse(readFileSync(f.state, 'utf8')).draft, false);
      execFileSync(process.execPath, args(f.local), { cwd: repoRoot, env, encoding: 'utf8' });
      const log = readFileSync(f.log, 'utf8');
      assert.equal(log.match(/release create/g)?.length, 1);
      assert.match(log, /release create .*--latest=false/);
      assert.equal(log.match(/release edit/g)?.length, 1);
      assert.equal(log.match(/release upload .*archive.tar.gz/g)?.length, 1);
      const beforePublish = log.slice(0, log.indexOf('gh release edit'));
      assert.match(beforePublish, /release download .*--pattern archive.tar.gz/);
      assert.match(beforePublish, /release download .*--pattern checksums.txt/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test('a public immutable release is audited without adding, replacing, pruning, or unpublishing assets', () => {
  const f = fixture();
  const env = { ...process.env, GH_REPO: 'test/test', PATH: `${f.bin}:${process.env.PATH ?? ''}` };
  try {
    writeFileSync(f.state, JSON.stringify({ draft: false }));
    writeFileSync(join(f.remote, 'archive.tar.gz'), 'authorized bytes\n');
    const incomplete = spawnSync(process.execPath, args(f.local), { cwd: repoRoot, env, encoding: 'utf8' });
    assert.notEqual(incomplete.status, 0);
    assert.match(incomplete.stderr, /published.*missing|public.*missing/i);
    assert.doesNotMatch(readFileSync(f.log, 'utf8'), /release (upload|edit|create)/);
    writeFileSync(join(f.remote, 'checksums.txt'), 'checksums\n');
    execFileSync(process.execPath, args(f.local), { cwd: repoRoot, env, encoding: 'utf8' });
    for (const flag of ['--clobber', '--prune-assets']) {
      const forbidden = args(f.local);
      forbidden[forbidden.indexOf(flag) + 1] = 'true';
      assert.notEqual(spawnSync(process.execPath, forbidden, { cwd: repoRoot, env }).status, 0);
    }
    assert.doesNotMatch(readFileSync(f.log, 'utf8'), /release (upload|edit|create)|-X DELETE/);
    assert.equal(JSON.parse(readFileSync(f.state, 'utf8')).draft, false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
