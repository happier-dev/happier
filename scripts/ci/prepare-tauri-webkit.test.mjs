import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const recipe = path.join(repoRoot, 'scripts/ci/prepare-tauri-webkit.sh');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tauri-webkit-recipe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const commands = path.join(root, 'commands');
  const executable = (name, text) => {
    fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' '${name}' >> "$PROBE_COMMANDS"\n${text}\n`, { mode: 0o755 });
  };
  // Network, ELF tooling, native loading, and compiler invocation are OS boundaries.
  executable('curl', 'while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then printf bad-archive > "$2"; exit 0; fi; shift; done; exit 1');
  executable('cmake', 'exit 99');
  executable('ldd', 'printf "libc.so.6 => /lib/libc.so.6\\n"');
  executable('readelf', 'printf "Version needs section\\n Name: GLIBC_2.35\\n Name: GLIBCXX_3.4.30\\n"');
  executable('python3', 'printf "%s\\n" "$PROBE_WEBKIT_VERSION"');
  const stage = path.join(root, 'stage');
  const run = (cacheHit, extra = {}) => spawnSync('bash', [recipe, '--stage-dir', stage, '--build-dir', path.join(root, 'build'), '--cache-hit', String(cacheHit)], {
    cwd: repoRoot, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROBE_COMMANDS: commands, PROBE_WEBKIT_VERSION: '2.54.1', ...extra },
  });
  const populate = () => {
    const lib = path.join(stage, 'usr/lib/x86_64-linux-gnu');
    for (const relative of ['libwebkit2gtk-4.1.so.0', 'libjavascriptcoregtk-4.1.so.0', ...['WebKitWebProcess', 'WebKitNetworkProcess', 'WebKitGPUProcess', 'MiniBrowser', 'jsc', 'injected-bundle/libwebkit2gtkinjectedbundle.so'].map((file) => `webkit2gtk-4.1/${file}`), '../../bin/WebKitWebDriver']) {
      const file = path.join(lib, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'ELF inspection fixture');
    }
  };
  return { stage, run, populate, calls: () => fs.existsSync(commands) ? fs.readFileSync(commands, 'utf8') : '' };
}

test('a source checksum failure stops before extraction or compilation', (t) => {
  const f = fixture(t);
  const result = f.run(false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum did NOT match|computed checksum did NOT match/);
  assert.equal(f.calls(), 'curl\n');
  assert.equal(fs.existsSync(path.join(f.stage, 'usr')), false);
});

test('an exact cache hit validates without downloading or compiling; invalid caches fail', (t) => {
  const f = fixture(t);
  f.populate();
  const valid = f.run(true);
  assert.equal(valid.status, 0, valid.stderr);
  assert.doesNotMatch(f.calls(), /curl|cmake/);
  const wrongVersion = f.run(true, { PROBE_WEBKIT_VERSION: '2.50.4' });
  assert.notEqual(wrongVersion.status, 0);
  assert.match(wrongVersion.stderr, /expected WebKitGTK 2.54.1/);
  fs.unlinkSync(path.join(f.stage, 'usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitGPUProcess'));
  const missingHelper = f.run(true);
  assert.notEqual(missingHelper.status, 0);
  assert.match(missingHelper.stderr, /WebKitGPUProcess/);
  assert.doesNotMatch(f.calls(), /curl|cmake/);
});
