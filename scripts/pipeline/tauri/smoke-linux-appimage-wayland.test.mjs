import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const smokeScript = new URL('./smoke-linux-appimage-wayland.mjs', import.meta.url);

function writeExecutable(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

test('native Wayland smoke waits for the Tauri ready marker before validating it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-wayland-smoke-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir);

  writeExecutable(path.join(binDir, 'weston'), `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
fs.writeFileSync(path.join(process.env.XDG_RUNTIME_DIR, 'happier-wayland'), '');
setInterval(() => {}, 30_000);
`);

  const appImage = path.join(root, 'happier.AppImage');
  writeExecutable(appImage, `#!/usr/bin/env bash
set -euo pipefail
mkdir -p squashfs-root
cat > squashfs-root/AppRun <<'APP_RUN'
#!/usr/bin/env node
import fs from 'node:fs';
setTimeout(() => fs.writeFileSync(process.env.HAPPIER_TAURI_STARTUP_MARKER, '{"phase":"ready"}\\n'), 200);
setInterval(() => {}, 30_000);
APP_RUN
chmod +x squashfs-root/AppRun
`);

  const output = execFileSync(process.execPath, [smokeScript.pathname, '--appimage', appImage, '--duration', '3'], {
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
    encoding: 'utf8',
    timeout: 10_000,
  });

  assert.match(output, /passed: remained alive for 3s/);
});
