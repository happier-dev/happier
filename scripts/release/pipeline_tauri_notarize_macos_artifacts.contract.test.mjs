import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const notarizeScriptPath = resolve(repoRoot, 'scripts', 'pipeline', 'tauri', 'notarize-macos-artifacts.mjs');

test('tauri notarize-macos-artifacts script supports dry-run', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'tauri', 'notarize-macos-artifacts.mjs'),
      '--ui-dir',
      'apps/ui',
      '--tauri-target',
      'aarch64-apple-darwin',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\bxcrun notarytool submit\b/);
  assert.match(out, /\btauri signer sign\b/);
});

test('tauri notarization retries transient Apple notarytool submit timeouts only', async () => {
  const source = readFileSync(notarizeScriptPath, 'utf8');
  assert.match(source, /shouldRetryNotarytoolSubmitError/);

  const timeoutError = new Error(
    'Command failed: xcrun notarytool submit app.zip --wait\n'
    + 'Error: HTTPError(statusCode: nil, error: Error Domain=NSURLErrorDomain Code=-1001 "The request timed out.")',
  );
  const signingError = new Error(
    'Command failed: xcrun notarytool submit app.zip --wait\n'
    + 'Error: The binary is not signed with a valid Developer ID certificate.',
  );

  const { shouldRetryNotarytoolSubmitError } = await import('../pipeline/tauri/notarize-macos-artifacts.mjs');
  assert.equal(shouldRetryNotarytoolSubmitError(timeoutError), true);
  assert.equal(shouldRetryNotarytoolSubmitError(signingError), false);
});

test('macOS notarization re-signs through a file key without inheriting a conflicting raw key', {
  skip: process.platform === 'win32' && 'macOS tool harness requires POSIX executables',
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'happier-notary-signer-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const bundle = join(root, 'src-tauri', 'target', 'aarch64-apple-darwin', 'release', 'bundle');
  mkdirSync(bin);
  mkdirSync(bundle, { recursive: true });
  const artifact = join(bundle, 'Happier.app.tar.gz');
  writeFileSync(artifact, 'candidate');
  writeFileSync(`${artifact}.sig`, 'candidate-signature');
  const otherTarget = join(root, 'src-tauri', 'target', 'x86_64-apple-darwin', 'release', 'bundle');
  mkdirSync(otherTarget, { recursive: true });
  writeFileSync(join(otherTarget, 'Cached.app.tar.gz.sig'), 'other-target-signature');
  const signature = Buffer.alloc(96, 8).toString('base64');

  // Only external macOS tools and the Tauri process are substituted. Run the
  // real notarization orchestration, key materializer, and child environment.
  writeFileSync(join(bin, 'tar'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '-xzf') fs.mkdirSync(path.join(args[args.indexOf('-C') + 1], 'Happier.app'));
else if (args[0] === '-czf') fs.writeFileSync(args[1], 'notarized-candidate');
else process.exit(1);
`, { mode: 0o755 });
  for (const command of ['ditto', 'xcrun']) {
    writeFileSync(join(bin, command), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
  }
  writeFileSync(join(bin, 'pnpm'), `#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('12.14.0'); process.exit(0); }
assert.equal(Object.keys(process.env).some((key) =>
  ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_PRIVATE_KEY'].includes(key.toUpperCase())), false);
assert.equal(fs.readFileSync(args[args.indexOf('--private-key-path') + 1], 'utf8'), 'opaque-key');
assert.equal(args[args.indexOf('--password') + 1], 'fallback-password');
assert.equal(process.env.MINISIGN_PASSPHRASE, 'fallback-password');
process.stdout.write(${JSON.stringify(`Signature: ${signature}\n`)});
`, { mode: 0o755 });

  execFileSync(process.execPath, [notarizeScriptPath, '--ui-dir', root, '--tauri-target', 'aarch64-apple-darwin'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      RUNNER_TEMP: join(root, 'tmp'),
      TAURI_SIGNING_PRIVATE_KEY: 'opaque-key',
      TAURI_PRIVATE_KEY: 'legacy-key',
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: undefined,
      MINISIGN_PASSPHRASE: 'fallback-password',
      APPLE_API_KEY_ID: 'test-key',
      APPLE_API_ISSUER_ID: 'test-issuer',
      APPLE_API_PRIVATE_KEY: 'test-apple-key',
    },
    stdio: 'pipe',
  });
  assert.equal(readFileSync(artifact, 'utf8'), 'notarized-candidate');
  assert.equal(readFileSync(`${artifact}.sig`, 'utf8'), `${signature}\n`);
});

test('macOS notarization refuses ambiguous current-target archives before contacting Apple', {
  skip: process.platform === 'win32' && 'macOS tool harness requires POSIX executables',
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'happier-notary-ambiguous-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const bundle = join(root, 'src-tauri', 'target', 'aarch64-apple-darwin', 'release', 'bundle');
  mkdirSync(bin);
  mkdirSync(bundle, { recursive: true });
  for (const name of ['Happier.app.tar.gz', 'Cached.app.tar.gz']) {
    writeFileSync(join(bundle, name), 'candidate');
    writeFileSync(join(bundle, `${name}.sig`), 'signature');
  }
  const contacted = join(root, 'apple-contacted');
  // Substitute OS/vendor processes only; keep real discovery and selection.
  writeFileSync(join(bin, 'tar'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.mkdirSync(path.join(args[args.indexOf('-C') + 1], 'Happier.app'));
`, { mode: 0o755 });
  writeFileSync(join(bin, 'ditto'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
  writeFileSync(join(bin, 'xcrun'), `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(contacted)}, 'called');
process.exit(1);
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [notarizeScriptPath,
    '--ui-dir', root, '--tauri-target', 'aarch64-apple-darwin'], {
    cwd: repoRoot,
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, RUNNER_TEMP: join(root, 'tmp'),
      APPLE_API_KEY_ID: 'test-key', APPLE_API_ISSUER_ID: 'test-issuer', APPLE_API_PRIVATE_KEY: 'test-key',
      TAURI_SIGNING_PRIVATE_KEY: '', TAURI_PRIVATE_KEY: '',
    },
    encoding: 'utf8',
  });
  assert.equal(existsSync(contacted), false, 'ambiguous archives must not reach Apple');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly one updater signature/);
});
