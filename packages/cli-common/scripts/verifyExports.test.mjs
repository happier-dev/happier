import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { collectMissingExportTargets } from './verifyExports.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(scriptsDir);

describe('cli-common build export verification', () => {
  it('exports a web-safe Tailscale task contract entrypoint', () => {
    const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));

    expect(packageJson.exports).toMatchObject({
      './tailscale/taskContract': {
        types: './dist/tailscale/taskContract.d.ts',
        default: './dist/tailscale/taskContract.js',
      },
    });
  });

  it('runs export verification as part of the package build', () => {
    const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));

    expect(packageJson.scripts.build).toContain('verifyExports.mjs');
  });

  it('detects missing files for declared export targets', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-cli-common-exports-'));

    try {
      mkdirSync(join(fixtureDir, 'dist', 'links'), { recursive: true });
      writeFileSync(join(fixtureDir, 'dist', 'links', 'index.js'), 'export const ok = true;\n', 'utf8');
      writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({
        name: '@happier-dev/cli-common-fixture',
        exports: {
          './links': {
            default: './dist/links/index.js',
          },
          './tailscale': {
            default: './dist/tailscale/index.js',
          },
        },
      }, null, 2), 'utf8');

      expect(collectMissingExportTargets({
        packageDir: fixtureDir,
        packageJson: JSON.parse(readFileSync(join(fixtureDir, 'package.json'), 'utf8')),
      })).toEqual([
        {
          target: './dist/tailscale/index.js',
          relativePath: 'dist/tailscale/index.js',
        },
      ]);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
