import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function createTarball(tmpDir, packageName = '@happier/npm-contract-fixture') {
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
  const integrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(tarballPath)).digest('base64')}`;
  return { tarballPath, integrity };
}

function writeNpmStub(tmpDir) {
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const npmPath = path.join(binDir, 'npm');
  fs.writeFileSync(
    npmPath,
    `#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
const callsPath = process.env.NPM_STUB_CALLS;
const statePath = process.env.NPM_STUB_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state.calls = (state.calls ?? 0) + 1;
state.history = [...(state.history ?? []), args];
if (callsPath) fs.appendFileSync(callsPath, JSON.stringify(args) + '\\n');
const writeState = () => fs.writeFileSync(statePath, JSON.stringify(state));
const mode = process.env.NPM_STUB_MODE;
const integrity = process.env.NPM_STUB_INTEGRITY;
const packageName = '@happier/npm-contract-fixture';
const packageVersion = '1.2.3';
if (args[0] === 'view' && args[2] === 'dist.integrity') {
  if (mode === 'absent' && state.integrityQueries === 0) {
    state.integrityQueries = 1;
    writeState();
    process.stderr.write('npm ERR! code E404\\n');
    process.exit(1);
  }
  if (mode === 'ambiguous' && state.integrityQueries === 0) {
    state.integrityQueries = 1;
    writeState();
    process.stderr.write('npm ERR! code E404\\n');
    process.exit(1);
  }
  state.integrityQueries = (state.integrityQueries ?? 0) + 1;
  writeState();
  process.stdout.write(JSON.stringify(state.remoteIntegrity ?? integrity) + '\\n');
  process.exit(0);
}
if (args[0] === 'view' && args[2] === 'dist-tags') {
  process.stdout.write(JSON.stringify(state.distTags ?? {}) + '\\n');
  process.exit(0);
}
if (args[0] === 'publish') {
  state.publishCalls = (state.publishCalls ?? 0) + 1;
  writeState();
  if (mode === 'ambiguous') {
    state.remoteIntegrity = integrity;
    state.distTags = {};
    writeState();
    process.stderr.write('npm ERR! network timeout after upload\\n');
    process.exit(1);
  }
  state.remoteIntegrity = integrity;
  writeState();
  process.stdout.write('published\\n');
  process.exit(0);
}
if (args[0] === 'dist-tag' && args[1] === 'add') {
  state.distTagAdds = (state.distTagAdds ?? 0) + 1;
  state.distTags = { ...(state.distTags ?? {}), [args[3]]: packageVersion };
  writeState();
  process.stdout.write('tagged\\n');
  process.exit(0);
}
process.stderr.write('unexpected npm invocation: ' + JSON.stringify(args) + '\\n');
process.exit(2);
`,
    { encoding: 'utf8', mode: 0o755 },
  );
  return binDir;
}

function runNpmPublication(tmpDir, mode, initialState, {
  githubOutput = false,
  packageName = '@happier/npm-contract-fixture',
  authorizedSha = 'a'.repeat(40),
} = {}) {
  const { tarballPath, integrity } = createTarball(tmpDir, packageName);
  const statePath = path.join(tmpDir, 'state.json');
  const callsPath = path.join(tmpDir, 'npm-calls.jsonl');
  const githubOutputPath = path.join(tmpDir, 'github-output');
  fs.writeFileSync(statePath, JSON.stringify(initialState), 'utf8');
  const binDir = writeNpmStub(tmpDir);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    NPM_STUB_MODE: mode,
    NPM_STUB_STATE: statePath,
    NPM_STUB_CALLS: callsPath,
    NPM_STUB_INTEGRITY: integrity,
    GITHUB_ACTIONS: 'false',
  };
  let error;
  try {
    execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'publish-tarball.mjs'),
        '--channel',
        'preview',
        '--tarball',
        tarballPath,
        '--npm-version',
        '',
        ...(authorizedSha ? ['--authorized-sha', authorizedSha] : []),
        ...(githubOutput ? ['--github-output', githubOutputPath] : []),
      ],
      { cwd: repoRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
    );
  } catch (caught) {
    error = caught;
  }
  return {
    error,
    state: JSON.parse(fs.readFileSync(statePath, 'utf8')),
    calls: (fs.existsSync(callsPath) ? fs.readFileSync(callsPath, 'utf8') : '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
    githubOutput: githubOutput && fs.existsSync(githubOutputPath)
      ? fs.readFileSync(githubOutputPath, 'utf8')
      : '',
  };
}

test('pipeline npm publish script supports dry-run and derives dist-tag from channel', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-'));
  const tarballDir = path.join(tmpDir, 'dist', 'release-assets', 'cli');
  fs.mkdirSync(tarballDir, { recursive: true });
  const tarballPath = path.join(tarballDir, 'happier-cli-v0.0.0-preview.tgz');
  fs.writeFileSync(tarballPath, 'dummy', 'utf8');

  const outLocal = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'publish-tarball.mjs'),
      '--channel',
      'preview',
      '--tarball-dir',
      tarballDir,
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, CI: '', GITHUB_ACTIONS: '' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(outLocal, /\[dry-run\] npx -y npm@11\.5\.1 publish /);
  assert.doesNotMatch(outLocal, /--provenance/, 'local default should not force npm provenance');
  assert.match(outLocal, /--access public/);
  assert.match(outLocal, /--tag next/);

  const outGithub = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'publish-tarball.mjs'),
      '--channel',
      'preview',
      '--tarball',
      tarballPath,
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, GITHUB_ACTIONS: 'true' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(outGithub, /\[dry-run\] npx -y npm@11\.5\.1 publish /);
  assert.match(outGithub, /--provenance/, 'GitHub Actions default should enable npm provenance');
});

test('pipeline npm publish uses isolated npmrc when NPM_TOKEN is provided', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-token-'));
  const tarballDir = path.join(tmpDir, 'dist', 'release-assets', 'cli');
  fs.mkdirSync(tarballDir, { recursive: true });
  const tarballPath = path.join(tarballDir, 'happier-cli-v0.0.0-preview.tgz');
  fs.writeFileSync(tarballPath, 'dummy', 'utf8');

  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'publish-tarball.mjs'),
      '--channel',
      'preview',
      '--tarball',
      tarballPath,
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, NPM_TOKEN: 'npm-token-for-test' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] npm auth: using isolated npmrc/);
  assert.doesNotMatch(out, /npm-token-for-test/, 'script output must never include the npm token');
});

test('pipeline npm publish skips an exact version, repairs its dist-tag, and verifies the repair', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-exact-'));
  const result = runNpmPublication(tmpDir, 'exact', {
    remoteIntegrity: undefined,
    distTags: { next: '1.2.2' },
    integrityQueries: 0,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.state.publishCalls ?? 0, 0, 'exact integrity must skip npm publish');
  assert.equal(result.state.distTagAdds, 1, 'wrong dist-tag must be repaired');
  assert.equal(result.state.distTags.next, '1.2.3');
  assert.ok(result.calls.some((args) => args[0] === 'view' && args[2] === 'dist.integrity'));
  assert.ok(result.calls.some((args) => args[0] === 'dist-tag' && args[1] === 'add'));
});

test('pipeline npm publish fails closed when the existing version has different integrity', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-mismatch-'));
  const result = runNpmPublication(tmpDir, 'mismatch', {
    remoteIntegrity: 'sha512-mismatch',
    distTags: {},
    integrityQueries: 0,
  });
  assert.notEqual(result.error, undefined);
  assert.equal(result.state.publishCalls ?? 0, 0, 'integrity mismatch must not republish');
  assert.equal(result.state.distTagAdds ?? 0, 0, 'integrity mismatch must not mutate tags');
});

test('pipeline npm publish requires an admitted exact source identity before any npm operation', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-no-admission-'));
  const result = runNpmPublication(tmpDir, 'exact', {
    remoteIntegrity: undefined,
    distTags: {},
    integrityQueries: 0,
  }, { authorizedSha: '' });

  assert.notEqual(result.error, undefined);
  assert.match(
    `${String(result.error?.message ?? '')}\n${String(result.error?.stderr ?? '')}`,
    /npm publication requires a release-admitted exact source SHA/,
  );
  assert.equal(result.state.calls ?? 0, 0, 'admission must reject before any npm operation');
});

test('pipeline npm publish blocks direct public SDK publication without a machine-readable readiness owner', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-public-sdk-'));
  const result = runNpmPublication(tmpDir, 'exact', {
    remoteIntegrity: undefined,
    distTags: {},
    integrityQueries: 0,
  }, {
    packageName: '@happier-dev/sdk',
    authorizedSha: 'a'.repeat(40),
  });

  assert.notEqual(result.error, undefined);
  assert.match(
    `${String(result.error?.message ?? '')}\n${String(result.error?.stderr ?? '')}`,
    /PUBLIC_SDK_READINESS_OWNER_UNAVAILABLE/,
  );
  assert.equal(result.state.calls ?? 0, 0, 'admission must reject before any npm operation');
});

test('pipeline npm publish recovers an ambiguous publish by re-querying exact integrity', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-recover-'));
  const result = runNpmPublication(tmpDir, 'ambiguous', {
    distTags: {},
    integrityQueries: 0,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.state.publishCalls, 1);
  assert.equal(result.state.integrityQueries, 2, 'ambiguous publish must trigger an integrity re-query');
  assert.equal(result.state.distTagAdds, 1, 'recovered publication must repair its dist-tag');
  assert.ok(result.calls.some((args) => args[0] === 'publish'));
});

test('pipeline npm publish emits the verified immutable package identity only after publish and tag verification', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-publish-output-'));
  const result = runNpmPublication(tmpDir, 'exact', {
    remoteIntegrity: undefined,
    distTags: { next: '1.2.3' },
    integrityQueries: 0,
  }, { githubOutput: true });
  assert.equal(result.error, undefined);
  assert.match(result.githubOutput, /^package=@happier\/npm-contract-fixture$/m);
  assert.match(result.githubOutput, /^version=1\.2\.3$/m);
  assert.match(result.githubOutput, /^integrity=sha512-/m);
});
