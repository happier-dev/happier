import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { signUpdaterArtifacts } from './sign-updater-artifacts.mjs';

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-tauri-sign-'));
  const bundleDir = path.join(root, 'bundle');
  fs.mkdirSync(path.join(bundleDir, 'nested'), { recursive: true });
  const artifacts = [
    path.join(bundleDir, 'happier.AppImage'),
    path.join(bundleDir, 'nested', 'Happier (dev)_0.2.10-266_x64_en-US.msi'),
  ];
  for (const artifact of artifacts) {
    fs.writeFileSync(artifact, 'candidate-bytes');
    fs.writeFileSync(`${artifact}.sig`, 'candidate-placeholder');
  }
  return { root, bundleDir, artifacts };
}

test('signUpdaterArtifacts signs every updater artifact and replaces only its paired signature', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const calls = [];
  const signature = Buffer.alloc(96, 7).toString('base64');

  const count = signUpdaterArtifacts({
    uiDir: fixture.root,
    searchDir: fixture.bundleDir,
    tmpRoot: fixture.root,
    env: {
      TAURI_SIGNING_PRIVATE_KEY: 'opaque-key',
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'opaque-password',
    },
    platform: 'linux',
  }, {
    ensureSigningKeyFile: () => path.join(fixture.root, 'signing.key'),
    resolveYarnInvocation: () => ({ cmd: 'yarn', prefixArgs: ['exec'] }),
    runSigner: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return `Signature: ${signature}\n`;
    },
  });

  assert.equal(count, 2);
  assert.deepEqual(calls.map((call) => call.args.at(-1)).sort(), [...fixture.artifacts].sort());
  for (const call of calls) {
    assert.equal(call.cmd, 'yarn');
    assert.deepEqual(call.args.slice(0, 7), [
      'exec', '--silent', 'tauri', 'signer', 'sign', '--private-key-path', path.join(fixture.root, 'signing.key'),
    ]);
    assert.deepEqual(call.args.slice(7, 9), ['--password', 'opaque-password']);
    assert.equal(call.options.cwd, fixture.root);
  }
  for (const artifact of fixture.artifacts) {
    assert.equal(fs.readFileSync(`${artifact}.sig`, 'utf8'), `${signature}\n`);
    assert.equal(fs.readFileSync(artifact, 'utf8'), 'candidate-bytes');
  }
});

test('signUpdaterArtifacts rejects orphaned signatures before invoking the signer', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.rmSync(fixture.artifacts[0]);
  let invoked = false;

  assert.throws(() => signUpdaterArtifacts({
    uiDir: fixture.root,
    searchDir: fixture.bundleDir,
    tmpRoot: fixture.root,
    env: { TAURI_SIGNING_PRIVATE_KEY: 'opaque-key' },
    platform: 'linux',
  }, {
    ensureSigningKeyFile: () => path.join(fixture.root, 'signing.key'),
    resolveYarnInvocation: () => ({ cmd: 'yarn', prefixArgs: [] }),
    runSigner: () => {
      invoked = true;
      return '';
    },
  }), /updater artifact must be a regular file/);
  assert.equal(invoked, false);
});

test('signUpdaterArtifacts rejects invalid signer output without replacing the candidate signature', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  assert.throws(() => signUpdaterArtifacts({
    uiDir: fixture.root,
    searchDir: fixture.bundleDir,
    tmpRoot: fixture.root,
    env: { TAURI_SIGNING_PRIVATE_KEY: 'opaque-key' },
    platform: 'linux',
  }, {
    ensureSigningKeyFile: () => path.join(fixture.root, 'signing.key'),
    resolveYarnInvocation: () => ({ cmd: 'yarn', prefixArgs: [] }),
    runSigner: () => 'not-a-signature',
  }), /invalid updater signature/);
  assert.equal(fs.readFileSync(`${fixture.artifacts[0]}.sig`, 'utf8'), 'candidate-placeholder');
});
