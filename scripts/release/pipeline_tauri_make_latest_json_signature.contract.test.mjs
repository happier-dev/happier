import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const makeLatestJsonScript = resolve(repoRoot, 'apps', 'ui', 'tools', 'tauri', 'make-latest-json.mjs');

const validSignature = Buffer.from(
  [
    'untrusted comment: signature from tauri secret key',
    `${'A'.repeat(88)}==`,
    'trusted comment: timestamp:1775372442\tfile:Happier.app.tar.gz',
    `${'B'.repeat(88)}==`,
    '',
  ].join('\n'),
  'utf8',
).toString('base64');
const truncatedSignature = Buffer.from(
  [
    'le:Happier.app.tar.gz',
    `${'B'.repeat(88)}==`,
    '',
  ].join('\n'),
  'utf8',
).toString('base64');

async function writePlatformArtifact(root, platformKey, artifactName, signature = validSignature) {
  const dir = join(root, platformKey);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, artifactName), 'artifact', 'utf8');
  await writeFile(join(dir, `${artifactName}.sig`), `${signature}\n`, 'utf8');
}

async function writeAllPlatformArtifacts(root, overrides = {}) {
  await writePlatformArtifact(root, 'linux-x86_64', 'happier-ui-desktop-linux-x86_64-v1.2.3.AppImage', overrides.linux);
  await writePlatformArtifact(root, 'windows-x86_64', 'happier-ui-desktop-windows-x86_64-v1.2.3.exe', overrides.windows);
  await writePlatformArtifact(root, 'darwin-x86_64', 'happier-ui-desktop-darwin-x86_64-v1.2.3.app.tar.gz', overrides.darwinX64);
  await writePlatformArtifact(root, 'darwin-aarch64', 'happier-ui-desktop-darwin-aarch64-v1.2.3.app.tar.gz', overrides.darwinArm64);
}

function runMakeLatestJson(artifactsDir, outPath) {
  return spawnSync(
    process.execPath,
    [
      makeLatestJsonScript,
      '--channel',
      'production',
      '--version',
      '1.2.3',
      '--pub-date',
      '2026-05-05T00:00:00Z',
      '--notes',
      'Release notes.',
      '--repo',
      'happier-dev/happier',
      '--release-tag',
      'ui-desktop-v1.2.3',
      '--artifacts-dir',
      artifactsDir,
      '--out',
      outPath,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );
}

test('make-latest-json rejects truncated updater signatures before publishing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-tauri-latest-json-signature-'));
  try {
    const artifactsDir = join(root, 'artifacts');
    const outPath = join(root, 'latest.json');
    await writeAllPlatformArtifacts(artifactsDir, { darwinArm64: truncatedSignature });

    const result = runMakeLatestJson(artifactsDir, outPath);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid updater signature file for platform "darwin-aarch64"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('make-latest-json preserves validated updater signatures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-tauri-latest-json-signature-'));
  try {
    const artifactsDir = join(root, 'artifacts');
    const outPath = join(root, 'latest.json');
    await writeAllPlatformArtifacts(artifactsDir);

    const result = runMakeLatestJson(artifactsDir, outPath);

    assert.equal(result.status, 0, result.stderr);
    const latest = JSON.parse(await readFile(outPath, 'utf8'));
    assert.equal(latest.platforms['darwin-aarch64'].signature, validSignature);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
