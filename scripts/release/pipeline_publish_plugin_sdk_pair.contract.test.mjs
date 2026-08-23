import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function createTarball(tmpDir, packageName, version) {
  const stageDir = path.join(tmpDir, `${packageName.replaceAll('/', '-').replaceAll('@', '')}-stage`);
  const packageDir = path.join(stageDir, 'package');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: packageName, version }), 'utf8');
  fs.writeFileSync(path.join(packageDir, 'index.js'), 'export {};\n', 'utf8');
  const tarball = path.join(tmpDir, `${packageName.replaceAll('/', '-').replaceAll('@', '')}.tgz`);
  execFileSync('tar', ['-czf', tarball, '-C', stageDir, 'package']);
  return tarball;
}

function writeNpmStub(tmpDir) {
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const npmPath = path.join(binDir, 'npm');
  fs.writeFileSync(npmPath, `#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const statePath = process.env.NPM_PAIR_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
const persist = () => fs.writeFileSync(statePath, JSON.stringify(state));
const packageNameFromTarball = (tarball) => JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' })).name;
if (args[0] === 'view' && args[2] === 'dist.integrity') {
  const name = args[1].slice(0, args[1].lastIndexOf('@'));
  if (!state.integrities[name]) {
    process.stderr.write('npm ERR! code E404\\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(state.integrities[name]) + '\\n');
  process.exit(0);
}
if (args[0] === 'view' && args[2] === 'dist-tags') {
  const tags = state.tags[args[1]] ?? {};
  process.stdout.write(JSON.stringify(tags) + '\\n');
  process.exit(0);
}
if (args[0] === 'publish') {
  const name = packageNameFromTarball(args[1]);
  state.integrities[name] = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(args[1])).digest('base64');
  persist();
  process.stdout.write('published\\n');
  process.exit(0);
}
if (args[0] === 'dist-tag' && args[1] === 'add') {
  const at = args[2].lastIndexOf('@');
  const name = args[2].slice(0, at);
  const version = args[2].slice(at + 1);
  state.tags[name] = { ...(state.tags[name] ?? {}), [args[3]]: version };
  persist();
  process.stdout.write('tagged\\n');
  process.exit(0);
}
process.stderr.write('unexpected npm invocation: ' + JSON.stringify(args) + '\\n');
process.exit(2);
`, { encoding: 'utf8', mode: 0o755 });
  return binDir;
}

test('plugin SDK pair publisher stages both tarballs before moving either public dist-tag through the canonical publisher', () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'publish-plugin-sdk-pair.mjs'),
      '--channel',
      'preview',
      '--sdk-tarball',
      '/tmp/plugin-sdk.tgz',
      '--ui-tarball',
      '/tmp/plugin-ui.tgz',
      '--dry-run',
    ],
    { cwd: repoRoot, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const publisher = 'scripts/pipeline/npm/publish-tarball.mjs';
  assert.match(out, new RegExp(`${publisher} --channel preview --tarball /tmp/plugin-sdk\\.tgz --tag next-staging`));
  assert.match(out, new RegExp(`${publisher} --channel preview --tarball /tmp/plugin-ui\\.tgz --tag next-staging`));
  const sdkStage = out.indexOf('plugin-sdk.tgz --tag next-staging');
  const uiStage = out.indexOf('plugin-ui.tgz --tag next-staging');
  const sdkPromotion = out.indexOf('plugin-sdk.tgz --tag next', sdkStage + 1);
  const uiPromotion = out.indexOf('plugin-ui.tgz --tag next', uiStage + 1);
  assert.ok(sdkStage >= 0 && uiStage > sdkStage && sdkPromotion > uiStage && uiPromotion > sdkPromotion);
  assert.doesNotMatch(out, /\bnpm publish\b/);
});

test('plugin SDK pair publisher emits both verified package identities only after the staged pair succeeds', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-plugin-sdk-pair-output-'));
  const version = '0.1.0-preview.7';
  const sdkTarball = createTarball(tempDir, '@happier-dev/plugin-sdk', version);
  const uiTarball = createTarball(tempDir, '@happier-dev/plugin-ui', version);
  const outputPath = path.join(tempDir, 'github-output');
  const statePath = path.join(tempDir, 'npm-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ integrities: {}, tags: {} }), 'utf8');
  const binDir = writeNpmStub(tempDir);

  execFileSync(process.execPath, [
    resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'publish-plugin-sdk-pair.mjs'),
    '--channel', 'preview',
    '--tarball-dir', tempDir,
    '--npm-version', '',
    '--github-output', outputPath,
  ], {
    cwd: repoRoot,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`, NPM_PAIR_STATE: statePath, GITHUB_ACTIONS: 'false' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = fs.readFileSync(outputPath, 'utf8');
  assert.match(output, /^plugin_sdk_package=@happier-dev\/plugin-sdk$/m);
  assert.match(output, new RegExp(`^plugin_sdk_version=${version}$`, 'm'));
  assert.match(output, /^plugin_sdk_integrity=sha512-/m);
  assert.match(output, /^plugin_ui_package=@happier-dev\/plugin-ui$/m);
  assert.match(output, new RegExp(`^plugin_ui_version=${version}$`, 'm'));
  assert.match(output, /^plugin_ui_integrity=sha512-/m);
});
