import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

for (const { channel, rollingTag } of [
  { channel: 'preview', rollingTag: 'ui-web-preview' },
  { channel: 'dev', rollingTag: 'ui-web-dev' },
]) {
  test(`pipeline CLI can publish ui-web rolling release for ${channel} in dry-run`, async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'publish-ui-web',
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

  assert.match(out, new RegExp(`\\[pipeline\\] ui-web: channel=${channel} tag=${rollingTag}`));
  assert.match(out, /scripts\/pipeline\/release\/publish-ui-web\.mjs/);
  });
}
