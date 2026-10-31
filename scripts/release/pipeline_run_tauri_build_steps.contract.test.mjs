import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function run(args, env = {}) {
  return spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runDryRunWithoutKeychain(args, env = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'happier-tauri-keychain-trap-'));
  const credentialAccess = path.join(root, 'credential-access');
  // Reject the OS credential executable while the real CLI and Tauri dry-run execute.
  writeFileSync(path.join(root, 'security'), String.raw`#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(credentialAccess)}, 'invoked\n');
process.stderr.write('TEST_KEYCHAIN_ACCESS_FORBIDDEN\n');
process.exit(86);
`, { mode: 0o755 });
  const scopedEnv = { ...env, PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}`, RUNNER_TEMP: root };
  try {
    assert.equal(spawnSync('security', [], { env: { ...process.env, ...scopedEnv } }).status, 86, 'credential trap must be executable');
    assert.equal(readFileSync(credentialAccess, 'utf8'), 'invoked\n');
    writeFileSync(credentialAccess, '');
    const result = run([...args, '--secrets-source', 'keychain', '--keychain-service', 'test-only-no-secret'], scopedEnv);
    assert.equal(readFileSync(credentialAccess, 'utf8'), '', 'Tauri dry-run must not access Keychain');
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const [environment, buildVersion] of [
  ['preview', '0.0.0-preview.1'],
  ['dev', '0.0.0-dev.1'],
]) {
  test(`pipeline run exposes tauri-build-updater-artifacts for ${environment} (dry-run)`, () => {
    const res = runDryRunWithoutKeychain(
      [
        'tauri-build-updater-artifacts',
        '--environment',
        environment,
        '--build-version',
        buildVersion,
        '--tauri-target',
        'x86_64-unknown-linux-gnu',
        '--ui-dir',
        'apps/ui',
        '--dry-run',
      ],
      {
        TAURI_SIGNING_PRIVATE_KEY: '/tmp/tauri.signing.key',
        APPLE_SIGNING_IDENTITY: 'Developer ID Application: Dummy',
      },
    );
    assert.equal(res.status, 0, `expected exit 0, got ${res.status} stderr=${res.stderr}`);
  });
}

test('pipeline run exposes tauri-notarize-macos-artifacts (dry-run)', () => {
  const res = runDryRunWithoutKeychain(
    [
      'tauri-notarize-macos-artifacts',
      '--ui-dir',
      'apps/ui',
      '--tauri-target',
      'aarch64-apple-darwin',
      '--dry-run',
    ],
  );
  assert.equal(res.status, 0, `expected exit 0, got ${res.status} stderr=${res.stderr}`);
});

for (const environment of ['preview', 'dev']) {
  test(`pipeline run exposes tauri-collect-updater-artifacts for ${environment} (dry-run)`, () => {
    const res = run(
      [
        'tauri-collect-updater-artifacts',
        '--environment',
        environment,
        '--platform-key',
        'linux-x64',
        '--ui-version',
        '0.0.0',
        '--tauri-target',
        'x86_64-unknown-linux-gnu',
        '--ui-dir',
        'apps/ui',
        '--dry-run',
      ],
    );
    assert.equal(res.status, 0, `expected exit 0, got ${res.status} stderr=${res.stderr}`);
    assert.match(res.stdout, /\[dry-run\] search: apps\/ui\/src-tauri\/target\/x86_64-unknown-linux-gnu/);
    assert.match(res.stdout, /\[dry-run\] output: dist\/tauri\/updates\/linux-x64/);
    assert.ok(res.stdout.includes(`[dry-run] out_base: happier-ui-desktop-${environment}-linux-x64`), res.stdout);
  });
}
