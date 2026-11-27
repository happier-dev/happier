import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline deploy CLI can run deploy dry-run using env-file mode', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'deploy',
      '--deploy-environment',
      'production',
      '--component',
      'docs',
      '--repository',
      'happier-dev/happier',
      '--ref-name',
      'deploy/production/docs',
      '--sha',
      '0123456789abcdef0123456789abcdef01234567',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        DEPLOY_WEBHOOK_URL: 'https://ci.example.com/api/deploy',
        CF_WEBHOOK_DEPLOY_CLIENT_ID: 'cf-id',
        CF_WEBHOOK_DEPLOY_CLIENT_SECRET: 'cf-secret',
        HAPPIER_DOCS_DEPLOY_WEBHOOKS: 'docs',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] deploy webhooks: env=production component=docs ref=deploy\/production\/docs/);
  assert.match(out, /Dokploy webhook target: ref=refs\/heads\/deploy\/production\/docs/);
});

test('pipeline deploy CLI refuses server webhooks without exact hosted images', () => {
  assert.throws(() => execFileSync(process.execPath, [
    resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
    'deploy', '--deploy-environment', 'production', '--component', 'server',
    '--repository', 'happier-dev/happier', '--ref-name', 'deploy/production/server',
    '--sha', '0123456789abcdef0123456789abcdef01234567', '--dry-run', '--secrets-source', 'env',
  ], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }), (error) => {
    assert.equal(error.status, 1);
    assert.match(error.stderr, /server requires exact hosted images; use DEPLOY — Deploy Branch with hosted_images or deploy-hosted-images\.mjs --images\./);
    return true;
  });
});

