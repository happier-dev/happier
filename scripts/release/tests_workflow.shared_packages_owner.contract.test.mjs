import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import YAML from 'yaml';

const root = new URL('../../', import.meta.url);
const checkoutAction = 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262';
const setupBunAction = 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6';
const stableDiscovery = Object.freeze({
  repository: 'happier-dev/happier',
  discoveryRef: 'cli-stable',
  path: '.ci/released-cli-stable',
});

test('root scripts own the shared workspace unit lane consumed by CI', async () => {
  const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const workflow = YAML.parse(await readFile(new URL('.github/workflows/tests.yml', root), 'utf8'));
  const sharedScript = String(packageJson?.scripts?.['test:shared-packages:local'] ?? '');
  const sharedOwner = await readFile(new URL('scripts/testing/lib/sharedPackageTestCommands.ts', root), 'utf8');
  const sharedJob = workflow?.jobs?.['shared-packages-unit'];
  const commands = (sharedJob?.steps ?? []).map((step) => String(step?.run ?? '')).join('\n');

  assert.equal(
    sharedJob?.['timeout-minutes'],
    45,
    'the complete shared-package sweep measured 18m27s locally, so its hosted budget must include setup and runner variance',
  );
  assert.match(commands, /yarn -s test:shared-packages:local --mode ci/);
  assert.equal(sharedScript, 'node --experimental-strip-types scripts/testing/runSharedPackageTests.ts');
  for (const workspace of [
    '@happier-dev/desktop',
    '@happier-dev/desktop-native',
    '@happier-dev/iroh-native',
    '@happier-dev/peer-transport',
    '@happier-dev/release-runtime',
    '@happier-dev/website',
  ]) {
    assert.match(sharedOwner, new RegExp(`'workspace', '${workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}', 'test'`));
  }
  assert.match(sharedOwner, /'workspace', '@happier-dev\/tests', 'test:scripts:self'/);
  assert.doesNotMatch(commands, /yarn workspace privacy-kit test\n/,
    'the workflow must consume the root-owned list instead of maintaining a second package list');
});

test('shared package CI materializes the current stable agent discovery baseline for website claims', async () => {
  const workflow = YAML.parse(await readFile(new URL('.github/workflows/tests.yml', root), 'utf8'));
  const sharedJob = workflow?.jobs?.['shared-packages-unit'];
  const steps = sharedJob?.steps ?? [];
  const baselineCheckouts = steps.filter((step) => step?.with?.repository === stableDiscovery.repository);
  const baselineCheckout = baselineCheckouts[0];
  const bunSetup = steps.find((step) => String(step?.name ?? '').includes('Setup Bun'));
  const sharedPackageRun = steps.find((step) => String(step?.run ?? '').includes('test:shared-packages:local'));

  assert.equal(sharedJob?.permissions?.contents, 'read');
  assert.equal(baselineCheckouts.length, 1, 'the shared-package job must materialize the released baseline once');
  assert.match(String(baselineCheckout?.name ?? ''), /stable discovery/i);
  assert.equal(baselineCheckout?.uses, checkoutAction);
  assert.equal(baselineCheckout?.with?.repository, stableDiscovery.repository);
  assert.equal(baselineCheckout?.with?.ref, stableDiscovery.discoveryRef);
  assert.doesNotMatch(String(baselineCheckout?.with?.ref ?? ''), /^[0-9a-f]{40}$/i);
  assert.doesNotMatch(String(baselineCheckout?.with?.ref ?? ''), /^cli-v\d/i);
  assert.equal(baselineCheckout?.with?.path, stableDiscovery.path);
  assert.doesNotMatch(String(baselineCheckout?.with?.path ?? ''), /(?:cli-v\d|[0-9a-f]{40})/i);
  assert.equal(baselineCheckout?.with?.['persist-credentials'], false);
  assert.match(String(baselineCheckout?.with?.['sparse-checkout'] ?? ''), /packages\/agents\/src/);
  assert.equal(bunSetup?.uses, setupBunAction);
  assert.equal(bunSetup?.with?.['bun-version'], '1.3.5');
  assert.equal(
    sharedPackageRun?.env?.HAPPIER_SHIPPED_TREE,
    `\${{ github.workspace }}/${stableDiscovery.path}`,
  );
  assert.ok(
    steps.indexOf(baselineCheckout) < steps.indexOf(sharedPackageRun),
    'the released source must exist before the aggregate starts its website command',
  );
  assert.ok(
    steps.indexOf(bunSetup) < steps.indexOf(sharedPackageRun),
    'Bun must exist before the aggregate starts its privacy-kit runtime command',
  );
});
