import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('collection rejects a macOS updater whose app or hsetup cannot run on the advertised architecture', { skip: process.platform === 'win32' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tauri-macos-arch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir);
  // lipo is an Apple OS boundary unavailable on Linux. Its fixture reports the
  // architectures of the extracted executable; archive extraction stays real.
  fs.writeFileSync(path.join(binDir, 'lipo'), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] !== '-archs') process.exit(2);
process.stdout.write(fs.readFileSync(process.argv[3], 'utf8'));
`, { mode: 0o755 });
  const script = new URL('./collect-updater-artifacts.mjs', import.meta.url).pathname;
  for (const [platformKey, appArch, helperArch, accepted] of [
    ['darwin-x86_64', 'x86_64', 'arm64', false],
    ['darwin-x86_64', 'arm64', 'x86_64', false],
    ['darwin-x86_64', 'x86_64', 'x86_64', true],
    ['darwin-x86_64', 'x86_64 arm64', 'x86_64 arm64', true],
    ['darwin-aarch64', 'arm64', 'x86_64', false],
    ['darwin-aarch64', 'arm64', 'arm64', true],
    ['darwin-x86_64', 'x86_64', null, false],
  ]) {
    const fixtureRoot = fs.mkdtempSync(path.join(root, 'case-'));
    const triple = platformKey === 'darwin-x86_64' ? 'x86_64-apple-darwin' : 'aarch64-apple-darwin';
    const uiDir = path.join(fixtureRoot, 'ui');
    const bundleDir = path.join(uiDir, 'src-tauri', 'target', triple, 'release', 'bundle', 'macos');
    const macosDir = path.join(bundleDir, 'Happier (preview).app', 'Contents', 'MacOS');
    fs.mkdirSync(macosDir, { recursive: true });
    fs.writeFileSync(path.join(macosDir, 'app'), appArch);
    if (helperArch !== null) fs.writeFileSync(path.join(macosDir, 'hsetup'), helperArch);
    const archive = path.join(bundleDir, 'Happier.app.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', bundleDir, 'Happier (preview).app']);
    fs.writeFileSync(`${archive}.sig`, 'signature');
    const result = spawnSync(process.execPath, [script, '--environment', 'preview', '--platform-key', platformKey,
      '--ui-version', '0.2.12', '--tauri-target', triple, '--ui-dir', uiDir], {
      cwd: fixtureRoot, encoding: 'utf8', env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
    });
    if (accepted) assert.equal(result.status, 0, result.stderr);
    else {
      assert.notEqual(result.status, 0, `accepted ${platformKey} with app=${appArch}, hsetup=${helperArch}`);
      assert.match(result.stderr, /architecture|hsetup/);
      assert.equal(fs.existsSync(path.join(fixtureRoot, 'dist', 'tauri', 'updates', platformKey)), false);
    }
  }
});
