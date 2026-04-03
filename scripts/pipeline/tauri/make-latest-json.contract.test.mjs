import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

function writeFile(p, contents) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
}

test('tauri latest.json generator tolerates flattened updater artifacts (no platform subfolders)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-tauri-latest-json-'));
  const artifactsDir = path.join(tmp, 'updates');
  const outPath = path.join(tmp, 'latest.json');

  // In GitHub Actions, actions/upload-artifact strips the leading directory prefix and downloads
  // files directly into the merge target. The platform key may only appear in the filename.
  const fixtures = [
    {
      platform: 'linux-x86_64',
      file: 'happier-ui-desktop-dev-linux-x86_64.AppImage',
      sig: 'linux-sig',
    },
    {
      platform: 'windows-x86_64',
      file: 'happier-ui-desktop-dev-windows-x86_64.nsis.zip',
      sig: 'windows-sig',
    },
    {
      platform: 'darwin-x86_64',
      file: 'happier-ui-desktop-dev-darwin-x86_64.app.tar.gz',
      sig: 'darwin-x86_64-sig',
    },
    {
      platform: 'darwin-aarch64',
      file: 'happier-ui-desktop-dev-darwin-aarch64.app.tar.gz',
      sig: 'darwin-aarch64-sig',
    },
  ];

  for (const { file, sig } of fixtures) {
    writeFile(path.join(artifactsDir, file), 'artifact');
    writeFile(path.join(artifactsDir, `${file}.sig`), `${sig}\n`);
  }

  execFileSync(
    process.execPath,
    [
      path.resolve('apps/ui/tools/tauri/make-latest-json.mjs'),
      '--channel',
      'dev',
      '--version',
      '0.1.2-dev.123',
      '--pub-date',
      '2026-04-03T00:00:00Z',
      '--notes',
      'Rolling dev build.',
      '--repo',
      'happier-dev/happier',
      '--release-tag',
      'ui-desktop-dev',
      '--artifacts-dir',
      artifactsDir,
      '--out',
      outPath,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const latest = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(latest.version, '0.1.2-dev.123');
  assert.equal(latest.pub_date, '2026-04-03T00:00:00Z');
  assert.equal(latest.notes, 'Rolling dev build.');

  for (const { platform, file, sig } of fixtures) {
    assert.ok(latest.platforms[platform], `missing platform entry for ${platform}`);
    assert.equal(latest.platforms[platform].signature, sig);
    assert.equal(latest.platforms[platform].url, `https://github.com/happier-dev/happier/releases/download/ui-desktop-dev/${file}`);
  }
});

