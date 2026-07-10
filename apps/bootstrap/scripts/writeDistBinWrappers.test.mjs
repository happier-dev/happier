import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

test('writeDistBinWrappers writes into the staged workspace dist output', () => {
  const sandboxRoot = mkdtempSync(join(tmpdir(), 'hsetup-dist-wrappers-'));
  const packageRoot = join(sandboxRoot, 'bootstrap');
  const copiedScriptsDir = join(packageRoot, 'scripts');
  const liveDistBinDir = join(packageRoot, 'dist', 'bin');
  const stagedDistDir = join(packageRoot, '.staged-dist');

  try {
    mkdirSync(copiedScriptsDir, { recursive: true });
    mkdirSync(liveDistBinDir, { recursive: true });
    mkdirSync(stagedDistDir, { recursive: true });
    copyFileSync(join(scriptsDir, 'writeDistBinWrappers.mjs'), join(copiedScriptsDir, 'writeDistBinWrappers.mjs'));

    const scriptHelperPath = join(scriptsDir, 'writeDistExecutableWrapper.mjs');
    if (existsSync(scriptHelperPath)) {
      copyFileSync(scriptHelperPath, join(copiedScriptsDir, 'writeDistExecutableWrapper.mjs'));
    }

    writeFileSync(
      join(liveDistBinDir, 'writeDistExecutableWrapper.js'),
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { dirname } from 'node:path';",
        'export async function writeDistExecutableWrapper(params) {',
        '  mkdirSync(dirname(params.targetPath), { recursive: true });',
        "  writeFileSync(params.targetPath, 'live-dist-wrapper\\n', 'utf8');",
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = spawnSync(process.execPath, [join(copiedScriptsDir, 'writeDistBinWrappers.mjs')], {
      cwd: packageRoot,
      env: {
        ...process.env,
        HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: stagedDistDir,
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(join(stagedDistDir, 'bin', 'hsetup')), true);
    assert.equal(existsSync(join(liveDistBinDir, 'hsetup')), false);
  } finally {
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
});
