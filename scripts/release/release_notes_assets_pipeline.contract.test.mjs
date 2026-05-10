import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const buildScript = resolve(repoRoot, 'scripts/pipeline/release/release-notes/build-release-notes-assets.mjs');
const publishScript = resolve(repoRoot, 'scripts/pipeline/release/release-notes/publish-release-notes-assets.mjs');

function makeFixtureBundle() {
  const root = mkdtempSync(join(tmpdir(), 'happier-release-notes-assets-'));
  const manifest = join(root, 'manifest.generated.json');
  const assetsDir = join(root, 'assets');
  const outDir = join(root, 'out');
  mkdirSync(join(assetsDir, 'v9.9.9'), { recursive: true });
  writeFileSync(join(assetsDir, 'v9.9.9', 'hero.webp'), 'fixture-image');
  writeFileSync(manifest, `${JSON.stringify({
    schemaVersion: 'v1',
    latestReleaseId: 'v9.9.9',
    generatedAt: '2026-05-09T00:00:00.000Z',
    assetBaseUrl: 'https://github.com/happier-dev/happier-assets/releases/download/release-notes/',
    releases: [
      {
        releaseId: 'v9.9.9',
        versionLabel: '9.9.9',
        publishedAt: '2026-05-09',
        titleKey: 'releaseNotes.v9_9_9.title',
        cards: [
          {
            kind: 'image',
            titleKey: 'releaseNotes.v9_9_9.cards.hero.title',
            bodyKey: 'releaseNotes.v9_9_9.cards.hero.body',
            media: {
              key: 'hero.webp',
              altKey: 'releaseNotes.v9_9_9.cards.hero.alt',
            },
          },
        ],
      },
    ],
  }, null, 2)}\n`);
  return { root, manifest, assetsDir, outDir };
}

test('release notes asset build emits manifest, asset index, and prefixed media from explicit inputs', () => {
  const fixture = makeFixtureBundle();

  execFileSync(
    process.execPath,
    [
      buildScript,
      '--manifest', fixture.manifest,
      '--assets-dir', fixture.assetsDir,
      '--out-dir', fixture.outDir,
      '--assets-base-url', 'https://cdn.example.test/release-notes/',
    ],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  const manifestOut = JSON.parse(readFileSync(join(fixture.outDir, 'release-notes__manifest.json'), 'utf8'));
  assert.equal(manifestOut.latestReleaseId, 'v9.9.9');

  const index = JSON.parse(readFileSync(join(fixture.outDir, 'release-notes__assets-index.json'), 'utf8'));
  assert.equal(index.schemaVersion, 'v1');
  assert.equal(index.assetsBaseUrl, 'https://cdn.example.test/release-notes/');
  assert.deepEqual(Object.keys(index.assets), ['v9.9.9/hero.webp']);
  assert.equal(index.assets['v9.9.9/hero.webp'].fileName, 'release-notes__v9.9.9__hero.webp');
  assert.equal(index.assets['v9.9.9/hero.webp'].assetKey, 'v9.9.9/hero.webp');
  assert.equal(index.assets['v9.9.9/hero.webp'].releaseId, 'v9.9.9');
  assert.equal(index.assets['v9.9.9/hero.webp'].path, 'hero.webp');
  assert.equal(index.assets['v9.9.9/hero.webp'].contentType, 'image/webp');
  assert.equal(index.assets['v9.9.9/hero.webp'].sizeBytes, 'fixture-image'.length);
  assert.equal(readFileSync(join(fixture.outDir, 'release-notes__v9.9.9__hero.webp'), 'utf8'), 'fixture-image');
});

test('release notes asset build fails clearly when the generated manifest is missing', () => {
  const fixture = makeFixtureBundle();
  const missingManifest = join(fixture.root, 'missing-manifest.json');
  const result = spawnSync(
    process.execPath,
    [buildScript, '--manifest', missingManifest, '--assets-dir', fixture.assetsDir, '--out-dir', fixture.outDir],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Generated manifest not found/);
  assert.match(result.stderr, /parseReleaseNotes\.ts/);
});



test('release notes asset build fails when a manifest-referenced media file is missing', () => {
  const fixture = makeFixtureBundle();
  const missingAssetsDir = join(fixture.root, 'missing-assets');
  mkdirSync(join(missingAssetsDir, 'v9.9.9'), { recursive: true });

  const result = spawnSync(
    process.execPath,
    [buildScript, '--manifest', fixture.manifest, '--assets-dir', missingAssetsDir, '--out-dir', fixture.outDir],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing asset/i);
  assert.match(result.stderr, /v9\.9\.9\/hero\.webp/);
});

test('release notes asset build fails when authored assets are not referenced by the generated manifest', () => {
  const fixture = makeFixtureBundle();
  writeFileSync(join(fixture.assetsDir, 'v9.9.9', 'unused.webp'), 'unused-image');

  const result = spawnSync(
    process.execPath,
    [buildScript, '--manifest', fixture.manifest, '--assets-dir', fixture.assetsDir, '--out-dir', fixture.outDir],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unreferenced authored asset/i);
  assert.match(result.stderr, /v9\.9\.9\/unused\.webp/);
});

test('release notes asset publish dry-run targets happier-assets release-notes with clobbered bundle files', () => {
  const fixture = makeFixtureBundle();
  execFileSync(
    process.execPath,
    [buildScript, '--manifest', fixture.manifest, '--assets-dir', fixture.assetsDir, '--out-dir', fixture.outDir],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  const out = execFileSync(
    process.execPath,
    [publishScript, '--in-dir', fixture.outDir, '--dry-run'],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  assert.match(out, /gh release view release-notes --repo happier-dev\/happier-assets/);
  assert.match(out, /gh release upload release-notes/);
  assert.match(out, /release-notes__manifest\.json/);
  assert.match(out, /release-notes__assets-index\.json/);
  assert.match(out, /release-notes__v9\.9\.9__hero\.webp/);
  assert.match(out, /--repo happier-dev\/happier-assets --clobber/);
});

test('release notes asset publish fails before gh when the required bundle files are missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-release-notes-assets-missing-'));
  writeFileSync(join(root, 'release-notes__v9.9.9__hero.webp'), 'fixture-image');

  const result = spawnSync(
    process.execPath,
    [publishScript, '--in-dir', root, '--dry-run'],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release-notes__manifest\.json/);
  assert.match(result.stderr, /release-notes__assets-index\.json/);
});
