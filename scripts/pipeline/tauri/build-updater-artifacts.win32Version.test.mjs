import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveTauriBuildVersionConfig } from './build-updater-artifacts.mjs';

test('Windows build and finalization keep the feed version in the app and restrict numeric conversion to MSI', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tauri-windows-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pipeline = new URL('./build-updater-artifacts.mjs', import.meta.url).href;
  for (const channel of ['dev', 'preview']) {
    for (const mode of ['build', 'bundle']) {
      // Substitute only the OS/process platform and external npm/Tauri commands.
      // The real pipeline writes the actual config passed to the Tauri CLI.
      const source = `
        import fs from 'node:fs';
        import { fileURLToPath } from 'node:url';
        import cp from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        Object.defineProperty(process, 'platform', { value: 'win32' });
        cp.execFileSync = (command, args) => {
          fs.writeFileSync(${JSON.stringify(path.join(root, 'invocation.json'))}, JSON.stringify({ command, args }));
          return '';
        };
        syncBuiltinESMExports();
        process.argv = [process.execPath, fileURLToPath(${JSON.stringify(pipeline)}),
          '--environment', ${JSON.stringify(channel)}, '--build-version', ${JSON.stringify(`0.2.19-${channel}.398`)},
          '--ui-dir', ${JSON.stringify(root)}, ${JSON.stringify(mode === 'build' ? '--no-bundle' : '--bundle-only')}];
        await import(${JSON.stringify(pipeline)});
      `;
      const harness = path.join(root, 'pipeline.mjs');
      fs.writeFileSync(harness, source);
      execFileSync(process.execPath, [harness], {
        env: { ...process.env, RUNNER_TEMP: root, TAURI_SIGNING_PRIVATE_KEY: 'boundary-test-key' },
        stdio: 'pipe',
      });
      assert.match(fs.readFileSync(path.join(root, 'invocation.json'), 'utf8'), /tauri\.version\.override\.json/);
      const config = JSON.parse(fs.readFileSync(path.join(root, 'tauri.version.override.json'), 'utf8'));
      assert.equal(config.version, `0.2.19-${channel}.398`, 'the running app must use the feed identity');
      assert.equal(config.bundle.windows.wix.version, '0.2.19.398');
    }
  }
});

test('version config preserves platform identity and the existing MSI numeric limits', () => {
  for (const version of ['0.1.2', '0.1.2-dev.22', '0.1.2-preview.123']) {
    for (const platform of ['linux', 'darwin']) {
      assert.deepEqual(resolveTauriBuildVersionConfig(version, platform), { version });
    }
  }
  assert.deepEqual(resolveTauriBuildVersionConfig('0.1.2', 'win32'), { version: '0.1.2' });
  for (const [version, msiVersion] of [['0.1.2-dev.0', '0.1.2.1'], ['0.1.2-dev.65535', '0.1.2.65535'], ['0.1.2-dev.999999', '0.1.2.65535']]) {
    assert.deepEqual(resolveTauriBuildVersionConfig(version, 'win32'), {
      version, bundle: { windows: { wix: { version: msiVersion } } },
    });
  }
});

