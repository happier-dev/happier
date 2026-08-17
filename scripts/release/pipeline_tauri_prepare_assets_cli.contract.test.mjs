import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  });
}

test('production desktop publish assets are a flat signed immutable envelope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-tauri-prepare-assets-'));
  try {
    const artifactsDir = join(root, 'updates');
    const publishDir = join(root, 'publish');
    const binDir = join(root, 'bin');
    const keyPath = join(root, 'release.key');
    await mkdir(binDir);
    await writeFile(keyPath, 'test release key\n');
    await writeFile(
      join(binDir, 'minisign'),
      '#!/bin/sh\nset -eu\nout=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-x" ]; then out="$2"; shift 2; continue; fi\n  shift\ndone\nprintf "test signature\\n" > "$out"\n',
    );
    await chmod(join(binDir, 'minisign'), 0o755);
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
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          MINISIGN_SECRET_KEY: keyPath,
          MINISIGN_PASSPHRASE: '',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );

    const versionedDir = join(publishDir, 'ui-desktop-v');
    const versionedNames = (await readdir(versionedDir)).sort();

    assert.ok(versionedNames.includes('latest.json'));
    assert.ok(versionedNames.includes('happier-ui-desktop-linux-x86_64-v1.2.3.AppImage'));
    assert.ok(versionedNames.includes('happier-ui-desktop-linux-x86_64-v1.2.3.AppImage.sig'));
    assert.ok(versionedNames.includes('happier-ui-desktop-windows-x86_64-v1.2.3.exe'));
    assert.ok(versionedNames.includes('checksums-happier-ui-desktop-v1.2.3.txt'));
    assert.ok(versionedNames.includes('checksums-happier-ui-desktop-v1.2.3.txt.minisig'));
    assert.ok(versionedNames.every((name) => !name.includes('/')));
    assert.match(
      await readFile(join(versionedDir, 'checksums-happier-ui-desktop-v1.2.3.txt'), 'utf8'),
      /happier-ui-desktop-linux-x86_64-v1\.2\.3\.AppImage/,
    );
    await assert.rejects(readdir(join(publishDir, 'ui-desktop-stable')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
