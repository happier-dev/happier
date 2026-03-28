import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

for (const environment of ['preview', 'dev']) {
  test(`pipeline CLI can prepare tauri publish assets for ${environment} in dry-run`, async () => {
    const out = execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
        'tauri-prepare-assets',
        '--environment',
        environment,
        '--repo',
        'happier-dev/happier',
        '--ui-version',
        '1.2.3',
        '--dry-run',
        '--secrets-source',
        'env',
      ],
      {
        cwd: repoRoot,
        env: { ...process.env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );

    assert.match(out, /scripts\/pipeline\/tauri\/prepare-publish-assets\.mjs/);
    assert.match(out, new RegExp(`\\[pipeline\\] tauri publish assets: env=${environment}`));
  });
}
