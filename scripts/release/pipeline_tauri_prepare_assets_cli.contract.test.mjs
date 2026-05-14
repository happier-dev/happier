import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
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

async function writePlatformArtifact(root, platformKey, artifactName) {
  const dir = join(root, platformKey);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, artifactName), 'artifact', 'utf8');
  await writeFile(join(dir, `${artifactName}.sig`), `${validSignature}\n`, 'utf8');
}

async function listFilesRecursive(root) {
  const out = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

for (const environment of ['preview', 'dev', 'production']) {
  test(`pipeline CLI can prepare tauri publish assets for ${environment} in dry-run`, async () => {
    const out = execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
        'tauri-prepare-assets',
        '--environment',
        environment,
        '--repo',
        'happier-dev/happier',
        '--ui-version',
        '1.2.3',
        '--dry-run',
        '--secrets-source',
        'env',
      ],
      {
        cwd: repoRoot,
        env: { ...process.env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );

    assert.match(out, /scripts\/pipeline\/tauri\/prepare-publish-assets\.mjs/);
    assert.match(out, new RegExp(`\\[pipeline\\] tauri publish assets: env=${environment}`));
    if (environment === 'production') {
      assert.match(out, /copy dir: dist\/tauri\/updates -> dist\/tauri\/publish\/ui-desktop-stable/);
    }
  });
}

test('production stable publish assets use rolling filenames while versioned release assets keep versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-tauri-prepare-assets-'));
  try {
    const artifactsDir = join(root, 'updates');
    const publishDir = join(root, 'publish');
    await writePlatformArtifact(
      artifactsDir,
      'linux-x86_64',
      'happier-ui-desktop-linux-x86_64-v1.2.3.AppImage',
    );
    await writePlatformArtifact(
      artifactsDir,
      'windows-x86_64',
      'happier-ui-desktop-windows-x86_64-v1.2.3.exe',
    );
    await writePlatformArtifact(
      artifactsDir,
      'darwin-x86_64',
      'happier-ui-desktop-darwin-x86_64-v1.2.3.app.tar.gz',
    );
    await writePlatformArtifact(
      artifactsDir,
      'darwin-aarch64',
      'happier-ui-desktop-darwin-aarch64-v1.2.3.app.tar.gz',
    );

    execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'tauri', 'prepare-publish-assets.mjs'),
        '--environment',
        'production',
        '--repo',
        'happier-dev/happier',
        '--ui-version',
        '1.2.3',
        '--artifacts-dir',
        artifactsDir,
        '--publish-dir',
        publishDir,
      ],
      {
        cwd: repoRoot,
        env: { ...process.env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );

    const stableNames = (await listFilesRecursive(join(publishDir, 'ui-desktop-stable'))).map((file) =>
      file.slice(join(publishDir, 'ui-desktop-stable').length + 1),
    );
    const versionedNames = (await listFilesRecursive(join(publishDir, 'ui-desktop-v'))).map((file) =>
      file.slice(join(publishDir, 'ui-desktop-v').length + 1),
    );

    assert.ok(stableNames.includes('latest.json'));
    assert.ok(stableNames.includes('linux-x86_64/happier-ui-desktop-linux-x86_64.AppImage'));
    assert.ok(stableNames.includes('linux-x86_64/happier-ui-desktop-linux-x86_64.AppImage.sig'));
    assert.ok(stableNames.includes('windows-x86_64/happier-ui-desktop-windows-x86_64.exe'));
    assert.ok(stableNames.every((name) => !name.includes('-v1.2.3')));

    assert.ok(versionedNames.includes('linux-x86_64/happier-ui-desktop-linux-x86_64-v1.2.3.AppImage'));
    assert.ok(versionedNames.includes('linux-x86_64/happier-ui-desktop-linux-x86_64-v1.2.3.AppImage.sig'));
    assert.ok(versionedNames.includes('windows-x86_64/happier-ui-desktop-windows-x86_64-v1.2.3.exe'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
