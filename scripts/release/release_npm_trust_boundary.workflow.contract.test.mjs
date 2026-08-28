import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import YAML from 'yaml';

const workflowPath = new URL('../../.github/workflows/release-npm.yml', import.meta.url);

async function loadWorkflow() {
  return YAML.parse(await readFile(workflowPath, 'utf8'));
}

function checkoutSteps(job) {
  return (job?.steps ?? []).filter((step) => step?.uses === 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262');
}

function assertTrustedControlCheckout(job, label) {
  const checkouts = checkoutSteps(job);
  assert.equal(checkouts.length, 1, `${label} must have one control checkout`);
  assert.equal(checkouts[0].with?.repository, '${{ job.workflow_repository }}', `${label} repository`);
  assert.equal(checkouts[0].with?.ref, '${{ job.workflow_sha }}', `${label} ref`);
  assert.equal(checkouts[0].with?.['persist-credentials'], false, `${label} credentials`);
  assert.equal(checkouts[0].with?.path, undefined, `${label} control checkout must own the workspace root`);
}

test('npm candidate packing is permission-minimized and secret-free', async () => {
  const workflow = await loadWorkflow();
  const candidate = workflow.jobs?.release;
  assert.ok(candidate);
  assert.equal(workflow.permissions?.contents, 'read');
  assert.deepEqual(candidate.permissions, { contents: 'read' });
  assert.equal(candidate.environment, undefined);
  assert.doesNotMatch(
    JSON.stringify(candidate),
    /secrets\.|create-github-app-token|MINISIGN_|NODE_AUTH_TOKEN|NPM_TOKEN|id-token/,
  );

  const checkouts = checkoutSteps(candidate);
  assert.equal(checkouts.length, 2);
  assert.equal(checkouts[0].with?.repository, '${{ job.workflow_repository }}');
  assert.equal(checkouts[0].with?.ref, '${{ job.workflow_sha }}');
  assert.equal(checkouts[0].with?.['persist-credentials'], false);
  assert.equal(checkouts[1].with?.repository, undefined);
  assert.equal(checkouts[1].with?.ref, '${{ steps.release_inputs.outputs.authorized_sha }}');
  assert.equal(checkouts[1].with?.['persist-credentials'], false);
  const trustedCheckoutIndex = candidate.steps.findIndex((step) => step.name === 'Checkout trusted workflow control bytes');
  const resolveInputsIndex = candidate.steps.findIndex((step) => step.name === 'Resolve release inputs');
  const sourceCheckoutIndex = candidate.steps.findIndex((step) => step.name === 'Checkout source ref');
  assert.ok(trustedCheckoutIndex >= 0 && trustedCheckoutIndex < resolveInputsIndex);
  assert.ok(resolveInputsIndex < sourceCheckoutIndex);
  assert.match(JSON.stringify(candidate), /node scripts\/pipeline\/run\.mjs npm-release/);
});

test('every npm credential-bearing job executes workflow-SHA control and only publishes opaque tarballs', async () => {
  const workflow = await loadWorkflow();
  assertTrustedControlCheckout(workflow.jobs?.release_actor_guard, 'release_actor_guard');

  for (const [jobName, packageKey] of [
    ['publish-cli', 'cli'],
    ['publish-stack', 'stack'],
    ['publish-server-runner', 'server'],
  ]) {
    const job = workflow.jobs?.[jobName];
    assert.ok(job, jobName);
    assert.equal(job.environment, 'release-shared', `${jobName} environment`);
    assert.equal(job.permissions?.['id-token'], 'write', `${jobName} provenance permission`);
    assertTrustedControlCheckout(job, jobName);

    const source = JSON.stringify(job);
    assert.match(source, /scripts\/pipeline\/npm\/publish-tarball\.mjs/);
    assert.doesNotMatch(source, /scripts\/pipeline\/run\.mjs|install-yarn-dependencies|npm-release/);
    assert.match(source, new RegExp(`npm-pack-${packageKey}-.*needs\\.release\\.outputs\\.sha.*needs\\.release\\.outputs\\.${packageKey === 'server' ? 'server_version' : `${packageKey}_version`}`));
    const download = job.steps.find((step) => step.uses === 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093');
    assert.equal(download?.with?.path, `dist/release-assets/${packageKey}`);
  }
});

test('npm pack artifacts are source-and-version-bound and shell scripts receive inputs through env', async () => {
  const workflow = await loadWorkflow();
  const candidate = workflow.jobs?.release;

  for (const [label, packageKey, versionOutput] of [
    ['Upload npm pack artifact (cli)', 'cli', 'cli_version'],
    ['Upload npm pack artifact (stack)', 'stack', 'stack_version'],
    ['Upload npm pack artifact (server runner)', 'server', 'server_version'],
  ]) {
    const step = candidate.steps.find((entry) => entry.name === label);
    assert.ok(step, label);
    assert.equal(
      step.with?.name,
      `npm-pack-${packageKey}-\${{ steps.meta.outputs.sha }}-\${{ steps.meta.outputs.${versionOutput} }}`,
    );
  }

  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (typeof step.run !== 'string') continue;
      assert.doesNotMatch(step.run, /\$\{\{\s*inputs\./, `${jobName}/${step.name} interpolates an input into shell`);
    }
  }
});

test('npm release workflow delegates release-ring validation and metadata emission to local owners', async () => {
  const workflow = await loadWorkflow();
  const inputResolution = workflow.jobs?.release?.steps?.find((step) => step.name === 'Resolve release inputs');
  const metadata = workflow.jobs?.release?.steps?.find((step) => step.name === 'Resolve release metadata');
  assert.match(String(inputResolution?.run ?? ''), /scripts\/pipeline\/release\/resolve-npm-release-inputs\.mjs/);
  assert.match(String(metadata?.run ?? ''), /scripts\/pipeline\/npm\/resolve-release-metadata\.mjs/);
  assert.doesNotMatch(String(inputResolution?.run ?? ''), /expected_tag=|source_ref=.*auto/);
  assert.doesNotMatch(String(metadata?.run ?? ''), /write_version_output|node --input-type=module|versions_json=/);
});

test('npm publication is reusable-only and requires the caller-admitted candidate SHA', async () => {
  const workflow = await loadWorkflow();
  const reusable = workflow.on?.workflow_call;
  const candidate = workflow.jobs?.release;
  const inputs = reusable?.inputs;

  assert.equal(workflow.on?.workflow_dispatch, undefined, 'release-npm must not be directly dispatchable');
  assert.equal(inputs?.authorized_sha?.required, true, 'the reusable workflow requires a candidate SHA');
  assert.equal(inputs?.authorized_sha?.default, undefined, 'the candidate SHA must not fall back to a branch');

  const inputResolution = candidate?.steps?.find((step) => step.name === 'Resolve release inputs');
  assert.equal(inputResolution?.env?.INPUT_AUTHORIZED_SHA, '${{ inputs.authorized_sha }}');
  assert.match(String(inputResolution?.run ?? ''), /--authorized-sha "\$INPUT_AUTHORIZED_SHA"/);

  const sourceCheckout = candidate?.steps?.find((step) => step.name === 'Checkout source ref');
  assert.equal(sourceCheckout?.with?.ref, '${{ steps.release_inputs.outputs.authorized_sha }}');
  assert.equal(
    candidate?.steps?.find((step) => step.name === 'Enforce caller-authorized source SHA'),
    undefined,
    'workflows must not duplicate source admission logic',
  );
  const pack = candidate?.steps?.find((step) => step.name === 'npm pack (pipeline)');
  assert.equal(pack?.env?.AUTHORIZED_SHA, '${{ steps.release_inputs.outputs.authorized_sha }}');
  assert.match(String(pack?.run ?? ''), /--authorized-sha "\$\{AUTHORIZED_SHA\}"/);
});

test('every npm publisher receives the immutable admitted candidate identity', async () => {
  const workflow = await loadWorkflow();
  for (const [jobName, stepName] of [
    ['publish-cli', 'npm publish (cli tarball) (pipeline)'],
    ['publish-stack', 'npm publish (stack tarball) (pipeline)'],
    ['publish-server-runner', 'npm publish (server runner tarball) (pipeline)'],
    ['publish-plugin-sdk-pair', 'npm publish (plugin SDK lockstep pair) (pipeline)'],
    ['publish-sdk', 'npm publish (SDK tarball) (pipeline)'],
    ['publish-channels-protocol', 'npm publish (Channels protocol tarball) (pipeline)'],
  ]) {
    const step = workflow.jobs?.[jobName]?.steps?.find((candidate) => candidate.name === stepName);
    assert.equal(step?.env?.AUTHORIZED_SHA, '${{ needs.release.outputs.sha }}', jobName);
    assert.match(String(step?.run ?? ''), /--authorized-sha "\$\{AUTHORIZED_SHA\}"/, jobName);
  }
});

test('public SDK releases use one lockstep pair publisher and return per-package identities to the reusable caller', async () => {
  const workflow = await loadWorkflow();
  const candidate = workflow.jobs?.release;
  const reusable = workflow.on?.workflow_call;

  assert.equal(reusable?.inputs?.publish_plugin_sdk?.type, 'boolean');
  assert.equal(reusable?.inputs?.publish_sdk?.type, 'boolean');
  assert.match(String(candidate?.outputs?.plugin_sdk_version ?? ''), /steps\.meta\.outputs\.plugin_sdk_version/);
  assert.match(String(candidate?.outputs?.sdk_version ?? ''), /steps\.meta\.outputs\.sdk_version/);

  const pairArtifact = candidate?.steps?.find((step) => step.name === 'Upload npm pack artifact (plugin SDK pair)');
  assert.equal(
    pairArtifact?.with?.name,
    'npm-pack-plugin-sdk-${{ steps.meta.outputs.sha }}-${{ steps.meta.outputs.plugin_sdk_version }}',
  );
  assert.equal(pairArtifact?.with?.path, 'dist/release-assets/plugin-sdk');

  const pair = workflow.jobs?.['publish-plugin-sdk-pair'];
  assert.ok(pair);
  assert.equal(pair.environment, 'release-shared');
  assert.equal(pair.permissions?.['id-token'], 'write');
  assertTrustedControlCheckout(pair, 'publish-plugin-sdk-pair');
  assert.match(JSON.stringify(pair), /scripts\/pipeline\/npm\/publish-plugin-sdk-pair\.mjs/);
  assert.doesNotMatch(pair.steps.map((step) => String(step.run ?? '')).join('\n'), /\bnpm publish\b/);
  assert.equal(
    pair.steps.find((step) => step.uses === 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093')?.with?.path,
    'dist/release-assets/plugin-sdk',
  );
  assert.equal(workflow.jobs?.['publish-plugin-ui'], undefined, 'the UI half must not become an independent publisher');

  const sdk = workflow.jobs?.['publish-sdk'];
  assert.ok(sdk);
  assertTrustedControlCheckout(sdk, 'publish-sdk');
  assert.match(JSON.stringify(sdk), /scripts\/pipeline\/npm\/publish-tarball\.mjs/);
  assert.equal(
    sdk.steps.find((step) => step.uses === 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093')?.with?.path,
    'dist/release-assets/sdk',
  );

  assert.match(String(reusable?.outputs?.plugin_sdk_integrity?.value ?? ''), /publish-plugin-sdk-pair\.outputs\.plugin_sdk_integrity/);
  assert.match(String(reusable?.outputs?.plugin_ui_integrity?.value ?? ''), /publish-plugin-sdk-pair\.outputs\.plugin_ui_integrity/);
  assert.match(String(reusable?.outputs?.sdk_integrity?.value ?? ''), /publish-sdk\.outputs\.sdk_integrity/);
});

test('the public Channels protocol is packed and published by the generic npm release owner', async () => {
  const workflow = await loadWorkflow();
  const candidate = workflow.jobs?.release;
  const reusable = workflow.on?.workflow_call;

  assert.equal(reusable?.inputs?.publish_channels_protocol?.type, 'boolean');
  assert.match(
    String(candidate?.outputs?.channels_protocol_version ?? ''),
    /steps\.meta\.outputs\.channels_protocol_version/,
  );

  const pack = candidate?.steps?.find((step) => step.name === 'npm pack (pipeline)');
  assert.match(String(pack?.if ?? ''), /inputs\.publish_channels_protocol/);
  assert.equal(pack?.env?.PUBLISH_CHANNELS_PROTOCOL, '${{ inputs.publish_channels_protocol }}');
  assert.match(String(pack?.run ?? ''), /--publish-channels-protocol "\$\{PUBLISH_CHANNELS_PROTOCOL\}"/);

  const artifact = candidate?.steps?.find((step) => step.name === 'Upload npm pack artifact (Channels protocol)');
  assert.equal(
    artifact?.with?.name,
    'npm-pack-channels-protocol-${{ steps.meta.outputs.sha }}-${{ steps.meta.outputs.channels_protocol_version }}',
  );
  assert.equal(artifact?.with?.path, 'dist/release-assets/channels-protocol');

  const job = workflow.jobs?.['publish-channels-protocol'];
  assert.ok(job, 'publish-channels-protocol');
  assert.equal(job.environment, 'release-shared');
  assert.equal(job.permissions?.['id-token'], 'write');
  assertTrustedControlCheckout(job, 'publish-channels-protocol');
  assert.match(JSON.stringify(job), /scripts\/pipeline\/npm\/publish-tarball\.mjs/);
  assert.doesNotMatch(
    JSON.stringify(job),
    /publish-plugin-sdk-pair/,
    'the Channels protocol has its own consumers and cadence; it never joins the lockstep pair publisher',
  );
  assert.equal(
    job.steps.find((step) => step.uses === 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093')?.with?.path,
    'dist/release-assets/channels-protocol',
  );
  assert.match(
    String(reusable?.outputs?.channels_protocol_integrity?.value ?? ''),
    /publish-channels-protocol\.outputs\.channels_protocol_integrity/,
  );
});
