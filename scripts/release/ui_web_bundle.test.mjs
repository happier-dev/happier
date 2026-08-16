import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { createUiWebReleaseArtifacts } from '../pipeline/release/lib/ui-web-bundle.mjs';
import { precompressUiWebAssets } from '../pipeline/release/lib/precompress-ui-web-assets.mjs';

process.env.LC_ALL = 'C';
process.env.LANG = 'C';

async function writeInstallablePwaFixture(distDir) {
  await mkdir(join(distDir, 'icons'), { recursive: true });
  await writeFile(
    join(distDir, 'index.html'),
    [
      '<!doctype html><html><head>',
      '<link rel="manifest" href="/manifest.webmanifest">',
      '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">',
      '</head></html>\n',
    ].join(''),
    'utf8',
  );
  await writeFile(
    join(distDir, 'manifest.webmanifest'),
    `${JSON.stringify({
      name: 'Happier',
      short_name: 'Happier',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      ],
    })}\n`,
    'utf8',
  );
  await Promise.all([
    writeFile(join(distDir, 'icons', 'icon-192.png'), '192'),
    writeFile(join(distDir, 'icons', 'icon-512.png'), '512'),
    writeFile(join(distDir, 'icons', 'apple-touch-icon.png'), 'apple'),
  ]);
}

test('createUiWebReleaseArtifacts packages dist into a deterministic ui-web tarball', async () => {
  const prevKey = process.env.MINISIGN_SECRET_KEY;
  const prevPassphrase = process.env.MINISIGN_PASSPHRASE;
  process.env.MINISIGN_SECRET_KEY = '';
  process.env.MINISIGN_PASSPHRASE = '';

  const root = await mkdtemp(join(tmpdir(), 'happier-ui-web-bundle-'));
  try {
    const distDir = join(root, 'dist');
    const outDir = join(root, 'out');
    await mkdir(join(distDir, 'assets'), { recursive: true });
    await writeInstallablePwaFixture(distDir);
    await writeFile(join(distDir, 'assets', 'health.txt'), 'ok\n', 'utf8');

    const result = await createUiWebReleaseArtifacts({
      version: '1.2.3-preview.1.1',
      distDir,
      outDir,
    });

    assert.equal(result.product, 'happier-ui-web');
    assert.equal(result.version, '1.2.3-preview.1.1');
    assert.ok(result.artifacts.length === 1);
    assert.equal(result.artifacts[0].name, 'happier-ui-web-v1.2.3-preview.1.1-web-any.tar.gz');

    const outEntries = await readdir(outDir);
    assert.ok(
      !outEntries.includes('.tmp-ui-web-stage'),
      'expected createUiWebReleaseArtifacts to clean up its staging directory',
    );

    const list = spawnSync('tar', ['-tzf', result.artifacts[0].path], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    });
    assert.equal(list.status, 0, `tar failed: ${String(list.stderr ?? '')}`);
    const output = String(list.stdout ?? '');
    assert.match(output, /happier-ui-web-v1\.2\.3-preview\.1\.1-web-any\/index\.html/);
    assert.match(output, /happier-ui-web-v1\.2\.3-preview\.1\.1-web-any\/assets\/health\.txt/);
  } finally {
    await rm(root, { recursive: true, force: true });
    if (prevKey == null) delete process.env.MINISIGN_SECRET_KEY;
    else process.env.MINISIGN_SECRET_KEY = prevKey;
    if (prevPassphrase == null) delete process.env.MINISIGN_PASSPHRASE;
    else process.env.MINISIGN_PASSPHRASE = prevPassphrase;
  }
});

test('createUiWebReleaseArtifacts rejects a web dist without its installable PWA contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-ui-web-bundle-pwa-missing-'));
  try {
    const distDir = join(root, 'dist');
    const outDir = join(root, 'out');
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, 'index.html'), '<!doctype html><html></html>\n', 'utf8');

    await assert.rejects(
      () => createUiWebReleaseArtifacts({ version: '1.2.3', distDir, outDir }),
      /manifest/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createUiWebReleaseArtifacts rejects a PWA manifest with a missing icon asset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-ui-web-bundle-pwa-icon-missing-'));
  try {
    const distDir = join(root, 'dist');
    const outDir = join(root, 'out');
    await writeInstallablePwaFixture(distDir);
    await rm(join(distDir, 'icons', 'icon-512.png'));

    await assert.rejects(
      () => createUiWebReleaseArtifacts({ version: '1.2.3', distDir, outDir }),
      /icon-512\.png/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createUiWebReleaseArtifacts rejects dist directories missing index.html', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-ui-web-bundle-missing-'));
  const distDir = join(root, 'dist');
  const outDir = join(root, 'out');
  await mkdir(distDir, { recursive: true });

  await assert.rejects(
    () => createUiWebReleaseArtifacts({ version: '1.2.3', distDir, outDir }),
    /index\.html/i,
  );

  await rm(root, { recursive: true, force: true });
});

test('precompressUiWebAssets can generate gzip-only sidecars for nginx static serving', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-ui-web-precompress-gzip-'));
  try {
    await writeFile(join(root, 'main.js'), 'console.log("gzip only");\n'.repeat(300), 'utf8');

    const result = await precompressUiWebAssets({ dir: root, encodings: ['gzip'] });

    assert.equal(result.scannedFiles, 1);
    assert.equal(result.gzipFiles, 1);
    assert.equal(result.brotliFiles, 0);
    await stat(join(root, 'main.js.gz'));
    await assert.rejects(() => stat(join(root, 'main.js.br')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
