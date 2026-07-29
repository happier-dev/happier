import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { prepareTypeScriptProjectBuild } from './prepareTypeScriptProjectBuild.mjs';

test('removes stale incremental metadata when the configured outDir is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-ts-build-prep-'));
  try {
    const tsconfigPath = join(root, 'tsconfig.json');
    const buildInfoPath = join(root, '.tsbuildinfo');
    writeFileSync(
      tsconfigPath,
      JSON.stringify({
        compilerOptions: {
          outDir: 'dist',
          incremental: true,
          tsBuildInfoFile: '.tsbuildinfo',
        },
      }),
      'utf8',
    );
    writeFileSync(buildInfoPath, 'stale', 'utf8');

    prepareTypeScriptProjectBuild({ tsconfigPath });

    assert.equal(existsSync(buildInfoPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeps incremental metadata when the configured outDir still exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-ts-build-prep-'));
  try {
    mkdirSync(join(root, 'dist'), { recursive: true });
    const tsconfigPath = join(root, 'tsconfig.json');
    const buildInfoPath = join(root, '.tsbuildinfo');
    writeFileSync(
      tsconfigPath,
      JSON.stringify({
        compilerOptions: {
          outDir: 'dist',
          incremental: true,
          tsBuildInfoFile: '.tsbuildinfo',
        },
      }),
      'utf8',
    );
    writeFileSync(buildInfoPath, 'fresh', 'utf8');

    prepareTypeScriptProjectBuild({ tsconfigPath });

    assert.equal(existsSync(buildInfoPath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
