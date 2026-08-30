import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

test('collect-updater-artifacts publishes Linux deb/rpm alongside the AppImage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-tauri-linux-assets-'));
  const searchDir = path.join(root, 'apps/ui/src-tauri/target/release/bundle');
  const appImage = path.join(searchDir, 'appimage/happier.AppImage');
  const signature = Buffer.from('untrusted comment: test\ntrusted comment: test\nsignature\n').toString('base64');
  writeFile(appImage, 'appimage');
  writeFile(`${appImage}.sig`, `${signature}\n`);
  writeFile(path.join(searchDir, 'deb/happier.deb'), 'deb');
  writeFile(path.join(searchDir, 'rpm/happier.rpm'), 'rpm');

  execFileSync(process.execPath, [
    path.resolve('scripts/pipeline/tauri/collect-updater-artifacts.mjs'),
    '--environment', 'dev',
    '--platform-key', 'linux-x86_64',
    '--ui-version', '0.1.0',
    '--ui-dir', path.join(root, 'apps/ui'),
  ], { stdio: 'pipe' });

  const outDir = path.resolve('dist/tauri/updates/linux-x86_64');
  assert.ok(fs.existsSync(path.join(outDir, 'happier-ui-desktop-dev-linux-x86_64.AppImage')));
  assert.ok(fs.existsSync(path.join(outDir, 'happier-ui-desktop-dev-linux-x86_64.deb')));
  assert.ok(fs.existsSync(path.join(outDir, 'happier-ui-desktop-dev-linux-x86_64.rpm')));
  assert.match(fs.readFileSync(path.join(outDir, 'happier-ui-desktop-dev-linux-x86_64.deb.sha256'), 'utf8'), /^[a-f0-9]{64}  happier-ui-desktop-dev-linux-x86_64\.deb\n$/);
});
