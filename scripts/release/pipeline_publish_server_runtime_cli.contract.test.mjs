import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

for (const { channel, rollingTag } of [
  { channel: 'preview', rollingTag: 'server-preview' },
  { channel: 'dev', rollingTag: 'server-dev' },
]) {
  test(`pipeline CLI can publish server-runtime rolling release for ${channel} in dry-run`, async () => {
    const out = execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
        'publish-server-runtime',
        '--channel',
        channel,
        '--allow-stable',
        'false',
        '--run-contracts',
        'false',
        '--check-installers',
        'false',
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

    assert.match(out, new RegExp(`\\[pipeline\\] server-runtime: channel=${channel} tag=${rollingTag}`));
    assert.match(out, /scripts\/pipeline\/release\/publish-server-runtime\.mjs/);
    // Manifests embed absolute GitHub release URLs; ensure we never emit a double-slash repo placeholder.
    assert.doesNotMatch(out, /https:\/\/github\.com\/\/releases\//);

    const wrapperSource = fs.readFileSync(resolve(repoRoot, 'scripts', 'pipeline', 'release', 'publish-server-runtime.mjs'), 'utf8');
    assert.match(wrapperSource, /publishing\/publish-binary-release\.mjs/);
  });
}
