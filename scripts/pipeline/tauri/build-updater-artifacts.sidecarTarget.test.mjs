import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('the candidate builder compiles hsetup for the requested bundle target before invoking Tauri', { skip: process.platform === 'win32' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tauri-sidecar-target-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const uiDir = path.join(root, 'ui');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(uiDir);
  fs.mkdirSync(binDir);
  const capture = path.join(root, 'target.json');
  // Yarn and rustup are external process boundaries. Run the real pipeline and
  // sidecar target resolver without compiling a frontend or downloading a toolchain.
  fs.writeFileSync(path.join(binDir, 'rustup'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'yarn'), `#!${process.execPath}
import fs from 'node:fs';
if (process.argv.includes('--version')) { console.log('1.22.22'); }
else if (process.argv.includes('tauri:prepare:build')) {
  const { resolveBunTargetForTauriBuildEnv } = await import(process.env.SIDECAR_RESOLVER);
  fs.writeFileSync(process.env.TARGET_CAPTURE, JSON.stringify({
    triple: process.env.TAURI_ENV_TARGET_TRIPLE,
    bunTarget: resolveBunTargetForTauriBuildEnv(process.env),
  }));
}
`, { mode: 0o755 });
  const script = new URL('./build-updater-artifacts.mjs', import.meta.url).pathname;
  for (const [triple, bunTarget] of [
    ['x86_64-apple-darwin', 'bun-darwin-x64'],
    ['aarch64-apple-darwin', 'bun-darwin-arm64'],
    ['x86_64-pc-windows-msvc', 'bun-windows-x64'],
    ['x86_64-unknown-linux-gnu', 'bun-linux-x64-baseline'],
  ]) {
    execFileSync(process.execPath, [script, '--environment', 'preview', '--build-version', '0.2.12-preview.1',
      '--tauri-target', triple, '--ui-dir', uiDir, '--no-bundle'], {
      cwd: root,
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        TAURI_ENV_TARGET_TRIPLE: 'aarch64-apple-darwin', TARGET: 'aarch64-apple-darwin',
        HAPPIER_TAURI_LINUX_HSETUP_LDD_PREFLIGHT: '0', RUNNER_TEMP: root,
        SIDECAR_RESOLVER: new URL('../../../apps/ui/scripts/prepareTauriSidecar.mjs', import.meta.url).href,
        TARGET_CAPTURE: capture },
      stdio: 'pipe',
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), { triple, bunTarget });
  }
});
