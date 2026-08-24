import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function createTarball(tmpDir, packageName) {
  const packageDir = path.join(tmpDir, 'package');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: packageName, version: '1.2.3' }),
    'utf8',
  );
  fs.writeFileSync(path.join(packageDir, 'index.js'), 'export {};\n', 'utf8');
  const tarballPath = path.join(tmpDir, 'fixture.tgz');
  execFileSync('tar', ['-czf', tarballPath, '-C', tmpDir, 'package']);
  return tarballPath;
}

function writeNpxStub(tmpDir) {
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'npx'),
    `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(process.env.NPM_PUBLISH_STUB_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(91);
`,
    { encoding: 'utf8', mode: 0o755 },
  );
  return binDir;
}

function writeSecurityStub(binDir, logPath) {
  fs.writeFileSync(
    path.join(binDir, 'security'),
    `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(91);
`,
    { encoding: 'utf8', mode: 0o755 },
  );
}

test('pipeline CLI can npm-publish in dry-run using env-only secrets', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-cli-'));
  const tarballDir = path.join(tmpDir, 'dist', 'release-assets', 'cli');
  fs.mkdirSync(tarballDir, { recursive: true });
  fs.writeFileSync(path.join(tarballDir, 'happier-cli-v0.0.0-preview.tgz'), 'dummy', 'utf8');

  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'npm-publish',
      '--channel',
      'preview',
      '--tarball-dir',
      tarballDir,
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, NPM_TOKEN: 'npm-token' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] npm publish: channel=preview/);
  assert.match(out, /\[dry-run\] npx -y npm@11\.5\.1 publish /);
  assert.match(out, /--tag next/);
});

test('pipeline CLI maps the public dev lane to preview npm publishing with a dev dist-tag', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-cli-dev-'));
  const tarballDir = path.join(tmpDir, 'dist', 'release-assets', 'cli');
  fs.mkdirSync(tarballDir, { recursive: true });
  fs.writeFileSync(path.join(tarballDir, 'happier-cli-v0.0.0-dev.tgz'), 'dummy', 'utf8');

  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'npm-publish',
      '--channel',
      'dev',
      '--tarball-dir',
      tarballDir,
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, NPM_TOKEN: 'npm-token' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] npm publish: channel=dev/);
  assert.match(out, /publish-tarball\.mjs"\s+"--channel"\s+"preview"/);
  assert.match(out, /publish-tarball\.mjs"[\s\S]*"--tag"\s+"dev"/);
});

test('pipeline CLI blocks direct public SDK publication before secrets or npm', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-cli-admission-'));
  const tarballPath = createTarball(tmpDir, '@happier-dev/sdk');
  const npxLog = path.join(tmpDir, 'npx-calls.jsonl');
  const securityLog = path.join(tmpDir, 'security-calls.jsonl');
  const binDir = writeNpxStub(tmpDir);
  writeSecurityStub(binDir, securityLog);
  let error;
  try {
    execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
        'npm-publish',
        '--channel', 'preview',
        '--tarball', tarballPath,
        '--authorized-sha', 'a'.repeat(40),
        '--allow-dirty', 'true',
        '--secrets-source', 'keychain',
      ],
      {
        cwd: repoRoot,
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          NPM_PUBLISH_STUB_LOG: npxLog,
          GITHUB_ACTIONS: 'false',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );
  } catch (caught) {
    error = caught;
  }

  assert.notEqual(error, undefined);
  assert.match(
    `${String(error?.message ?? '')}\n${String(error?.stderr ?? '')}`,
    /DIRECT_NPM_PUBLISH_DISABLED/,
  );
  assert.equal(fs.existsSync(npxLog), false, 'direct publication must reject before npm runs');
  assert.equal(fs.existsSync(securityLog), false, 'direct publication must reject before secret lookup runs');
});

test('pipeline CLI blocks direct unrelated tarball publication even with a caller-supplied admitted SHA', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-cli-unbound-'));
  const tarballPath = createTarball(tmpDir, '@happier/unbound-fixture');
  const npxLog = path.join(tmpDir, 'npx-calls.jsonl');
  const binDir = writeNpxStub(tmpDir);
  let error;
  try {
    execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
        'npm-publish',
        '--channel', 'preview',
        '--tarball', tarballPath,
        '--authorized-sha', 'a'.repeat(40),
        '--allow-dirty', 'true',
        '--secrets-source', 'env',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          NPM_PUBLISH_STUB_LOG: npxLog,
          NPM_TOKEN: 'npm-token',
          GITHUB_ACTIONS: 'false',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );
  } catch (caught) {
    error = caught;
  }

  assert.notEqual(error, undefined);
  assert.match(
    `${String(error?.message ?? '')}\n${String(error?.stderr ?? '')}`,
    /DIRECT_NPM_PUBLISH_DISABLED/,
  );
  assert.equal(fs.existsSync(npxLog), false, 'the unbound tarball must be rejected before npm runs');
});

test('pipeline CLI npm-publish help directs real publication to the checkout-bound npm-release owner', () => {
  const out = execFileSync(process.execPath, [resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'), 'help', 'npm-publish'], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });

  assert.match(out, /DIRECT_NPM_PUBLISH_DISABLED/);
  assert.match(out, /npm-release/i);
  assert.match(out, /checkout that prepared the candidate/i);
  assert.doesNotMatch(out, /Required for a real publication/i);
});
