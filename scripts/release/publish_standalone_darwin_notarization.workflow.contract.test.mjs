import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

async function loadWorkflow(name) {
  const raw = await readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
  return { raw, workflow: YAML.parse(raw) };
}

test('fresh Darwin finalizers explicitly build the trusted archive runtime before extraction', async () => {
  for (const workflowName of [
    'publish-cli-binaries.yml',
    'publish-hstack-binaries.yml',
    'publish-server-runtime.yml',
  ]) {
    const { workflow } = await loadWorkflow(workflowName);
    const steps = workflow.jobs?.finalize_darwin?.steps ?? [];
    const buildIndex = steps.findIndex((step) => step.name === 'Build trusted release archive runtime');
    const extractionIndex = steps.findIndex((step) => String(step.run ?? '').includes('node-archive.mjs'));
    const installStep = steps.find((step) => String(step.name ?? '').includes('Install'));
    assert.ok(buildIndex >= 0, `${workflowName} must explicitly build @happier-dev/release-runtime`);
    assert.ok(extractionIndex > buildIndex, `${workflowName} must build release-runtime before extraction`);
    assert.match(String(steps[buildIndex].run ?? ''), /yarn workspace @happier-dev\/release-runtime build/);
    assert.match(
      String(installStep?.with?.args ?? ''),
      /(?:^|\s)--ignore-scripts(?:\s|$)/,
      `${workflowName} must suppress lifecycle scripts before explicitly building trusted release-runtime`,
    );
  }
});

for (const product of [
  {
    id: 'hstack',
    workflow: 'publish-hstack-binaries.yml',
    archiveProduct: 'hstack',
    evidenceSuffix: 'hstack',
    publishNeeds: ['prepare', 'build_candidate', 'finalize_darwin'],
  },
  {
    id: 'server',
    workflow: 'publish-server-runtime.yml',
    archiveProduct: 'happier-server',
    evidenceSuffix: 'server',
    publishNeeds: ['prepare', 'build_candidate', 'finalize_darwin'],
  },
]) {
  test(`${product.id} publisher replaces both Darwin leaves with native Developer-ID signed and notarized archives before publication`, async () => {
    const { raw, workflow } = await loadWorkflow(product.workflow);
    const jobs = workflow.jobs;
    const darwin = jobs.finalize_darwin;
    const publish = jobs.finalize_publish;

    assert.ok(darwin, `${product.id} must have one Darwin finalization matrix`);
    assert.deepEqual(
      darwin.strategy.matrix.include.map(({ platform_key, runner, target }) => ({
        platform_key,
        runner,
        target,
      })),
      [
        { platform_key: 'darwin-x64', runner: 'macos-15-intel', target: 'darwin-x64' },
        { platform_key: 'darwin-arm64', runner: 'macos-15', target: 'darwin-arm64' },
      ],
    );
    assert.equal(darwin.environment, 'release-shared');
    const source = JSON.stringify(darwin);
    assert.match(source, /\.\/\.github\/actions\/setup-apple-codesigning/);
    assert.match(source, /Checkout trusted workflow control bytes/);
    assert.match(source, /job\.workflow_sha/);
    assert.doesNotMatch(source, /Checkout exact source/);
    const controlCheckout = darwin.steps.find(
      (step) => step.name === 'Checkout trusted workflow control bytes',
    );
    assert.equal(controlCheckout?.with?.ref, '${{ job.workflow_sha }}');
    assert.equal(controlCheckout?.with?.path, undefined);
    assert.match(source, /APPLE_API_KEY_ID/);
    assert.match(source, /APPLE_API_ISSUER_ID/);
    assert.match(source, /APPLE_API_PRIVATE_KEY/);
    assert.match(source, /notarize-standalone-binary\.mjs/);
    assert.match(source, /--archive/);
    assert.match(source, new RegExp(`${product.archiveProduct}-v`));
    assert.match(source, /--expected-payload/);
    assert.match(source, /--identity/);
    assert.match(source, /--out/);
    assert.match(source, new RegExp(`matrix\\.platform_key.*?${product.evidenceSuffix}\\.json`, 's'));
    assert.match(source, /--verify-evidence/);
    assert.match(source, /actions\/upload-artifact/);

    assert.deepEqual(publish.needs, product.publishNeeds);
    const publishSource = JSON.stringify(publish);
    assert.match(publishSource, /actions\/download-artifact/);
    assert.match(publishSource, /--prepared-artifacts/);
    assert.match(publishSource, new RegExp(`darwin-arm64\\.${product.evidenceSuffix}\\.json`));
    assert.match(publishSource, new RegExp(`darwin-x64\\.${product.evidenceSuffix}\\.json`));
    assert.doesNotMatch(
      publishSource,
      /--finalized-artifacts/,
      'publisher must generate the checksum and minisign envelope only after signed Darwin leaves are overlaid',
    );
    assert.match(raw, /setup-apple-codesigning/);
  });
}

test('Apple certificate import and identity resolution have one reusable workflow owner', async () => {
  const action = await readFile(
    new URL('../../.github/actions/setup-apple-codesigning/action.yml', import.meta.url),
    'utf8',
  );
  assert.match(action, /security create-keychain/);
  assert.match(action, /security import/);
  assert.match(action, /Developer ID Application/);
  assert.match(action, /security find-identity -v -p codesigning "\$\{keychain_path\}"/);
  assert.match(action, /\^\[0-9A-Fa-f\]\{40\}\$/);
  assert.ok(
    action.indexOf('echo "keychain_path=${keychain_path}"') < action.indexOf('security import'),
    'cleanup paths must be published before certificate import can fail',
  );
  assert.ok(
    action.indexOf('echo "certificate_path=${cert_path}"') < action.indexOf('security import'),
    'certificate cleanup path must be published before certificate import can fail',
  );
  for (const [workflowName, actionPath] of [
    ['build-tauri.yml', './.github/actions/setup-apple-codesigning'],
    ['publish-cli-binaries.yml', './.github/actions/setup-apple-codesigning'],
    ['publish-hstack-binaries.yml', './.github/actions/setup-apple-codesigning'],
    ['publish-server-runtime.yml', './.github/actions/setup-apple-codesigning'],
  ]) {
    const workflow = await readFile(
      new URL(`../../.github/workflows/${workflowName}`, import.meta.url),
      'utf8',
    );
    assert.match(workflow, new RegExp(actionPath.replaceAll('/', '\\/').replaceAll('.', '\\.')));
    assert.doesNotMatch(workflow, /security import "\$\{cert_path\}"/);
  }
  assert.ok(repoRoot.endsWith('/'));
});

test('the exact re-extracted finalized CLI executes on its native signing runner', async () => {
  const { workflow } = await loadWorkflow('publish-cli-binaries.yml');
  const finalize = workflow.jobs?.finalize_darwin;
  const signingStep = finalize?.steps?.find((step) => String(step.name ?? '').includes('Sign, notarize'));
  assert.ok(signingStep, 'missing CLI Darwin finalization step');
  assert.match(String(signingStep.run ?? ''), /VERIFY_DIR/);
  assert.match(String(signingStep.run ?? ''), /CLI_BIN/);
  assert.match(String(signingStep.run ?? ''), /"\$CLI_BIN" --version/);
});
