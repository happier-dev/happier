import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

for (const packagePath of [
  'packages/cli-common',
  'packages/peer-mediation',
  'packages/release-runtime',
  'packages/transfers',
  'packages/voice-modelpacks',
]) {
  test(`${packagePath} build honors the workspace staged output directory`, () => {
    const outputRoot = mkdtempSync(join(tmpdir(), `${basename(packagePath)}-staged-dist-`));
    try {
      const result = spawnSync('yarn', ['-s', 'build'], {
        cwd: join(repoRoot, packagePath),
        encoding: 'utf8',
        env: {
          ...process.env,
          HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: outputRoot,
        },
        timeout: 120_000,
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(existsSync(join(outputRoot, 'index.js')), true);
      assert.equal(existsSync(join(outputRoot, 'index.d.ts')), true);
    } finally {
      rmSync(outputRoot, { force: true, recursive: true });
    }
  });
}

test('packages/privacy-kit build honors the workspace staged output directory', () => {
  const packagePath = 'packages/privacy-kit';
  const outputRoot = mkdtempSync(join(tmpdir(), 'privacy-kit-staged-dist-'));
  try {
    const result = spawnSync('yarn', ['-s', 'build'], {
      cwd: join(repoRoot, packagePath),
      encoding: 'utf8',
      env: {
        ...process.env,
        HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: outputRoot,
      },
      timeout: 120_000,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const outputFile of ['index.cjs', 'index.d.cts', 'index.d.mts', 'index.mjs']) {
      assert.equal(
        existsSync(join(outputRoot, outputFile)),
        true,
        `privacy-kit staged build must emit ${outputFile}`,
      );
    }
    assert.equal(
      existsSync(join(outputRoot, 'package.json')),
      false,
      'privacy-kit staged build must remove its temporary stage manifest',
    );
  } finally {
    rmSync(outputRoot, { force: true, recursive: true });
  }
});
