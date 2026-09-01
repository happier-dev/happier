import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI npm-release supports --mode pack (no publish) in dry-run', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'npm-release',
      '--channel',
      'preview',
      '--publish-cli',
      'true',
      '--publish-stack',
      'false',
      '--publish-server',
      'false',
      '--mode',
      'pack',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, NPM_TOKEN: 'npm-token' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] npm release: channel=preview/);
  assert.match(out, /apps\/cli/);
  assert.doesNotMatch(out, /publish-tarball\.mjs/);
});

test('trusted npm release control can pack an explicit candidate repository root', () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts/pipeline/npm/release-packages.mjs'),
      '--repo-root',
      repoRoot,
      '--channel',
      'preview',
      '--publish-cli',
      'true',
      '--cli-version',
      '0.2.11-preview.2',
      '--run-tests',
      'false',
      '--mode',
      'pack',
      '--dry-run',
    ],
    {
      cwd: resolve(repoRoot, 'scripts'),
      env: {
        ...process.env,
        HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({
          github: {},
          npm: { '@happier-dev/cli': ['0.2.11-preview.2'] },
        }),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /apps\/cli/);
  assert.match(out, /0\.2\.11-preview\.2/);
});

test('pack mode explicitly admits reconstruction of an already-published exact version', () => {
  const source = readFileSync(resolve(repoRoot, 'scripts/pipeline/npm/release-packages.mjs'), 'utf8');
  assert.match(source, /allowExistingExactVersion:\s*mode === 'pack'/);
});

test('release-npm executes pack recovery from trusted control against inert candidate bytes', async () => {
  const { parse } = await import('yaml');
  const workflow = parse(readFileSync(resolve(repoRoot, '.github/workflows/release-npm.yml'), 'utf8'));
  const steps = workflow?.jobs?.release?.steps ?? [];
  const controlCheckout = steps.find((step) => step?.name === 'Checkout trusted npm release control');
  const packStep = steps.find((step) => step?.name === 'npm pack (pipeline)');

  assert.equal(controlCheckout?.with?.ref, '${{ job.workflow_sha }}');
  assert.equal(controlCheckout?.with?.path, 'trusted-control');
  assert.equal(controlCheckout?.with?.['persist-credentials'], false);
  assert.match(String(packStep?.run ?? ''), /trusted-control\/scripts\/pipeline\/npm\/release-packages\.mjs/);
  assert.match(String(packStep?.run ?? ''), /--repo-root "\$GITHUB_WORKSPACE"/);
});
