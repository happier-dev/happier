import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0].with?.['persist-credentials'], false);
  assert.notEqual(checkouts[0].with?.ref, '${{ job.workflow_sha }}');
  assert.match(JSON.stringify(candidate), /node scripts\/pipeline\/run\.mjs npm-release/);
});

test('an authorized npm candidate is checked out by exact SHA and rechecked against its canonical branch before packing', async () => {
  const workflow = await loadWorkflow();
  const candidate = workflow.jobs?.release;
  assert.equal(workflow.on?.workflow_call?.inputs?.authorized_sha?.default, '');
  const steps = candidate.steps ?? [];
  const checkoutIndex = steps.findIndex((step) => step.name === 'Checkout source ref');
  const verificationIndex = steps.findIndex((step) => step.name === 'Verify authorized source remains canonical');
  assert.ok(checkoutIndex >= 0);
  assert.ok(verificationIndex > checkoutIndex, 'canonical branch recheck must run after exact-SHA checkout');
  const verification = String(steps[verificationIndex]?.run ?? '');
  assert.match(verification, /git rev-parse HEAD/);
  assert.match(verification, /git ls-remote origin "refs\/heads\/\$CANONICAL_REF"/);
  assert.match(verification, /no longer resolves to authorized_sha/);
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

test('npm release metadata rejects newline output forgery before emitting package versions', async () => {
  const workflow = await loadWorkflow();
  const metadata = workflow.jobs?.release?.steps?.find((step) => step.name === 'Release metadata');
  const source = String(metadata?.run ?? '');
  assert.match(source, /rawVersion\.includes\('\\n'\)/);
  assert.match(source, /production:\s*\/\^/);
  assert.match(source, /preview:\s*\/\^/);
  assert.doesNotMatch(source, /import .*scripts\//);
  assert.match(source, /printf '%s=%s\\n' "\$output_name" "\$raw_version" >> "\$GITHUB_OUTPUT"/);
  assert.doesNotMatch(source, /echo "(?:cli|stack|server)_version=/);

  const helper = source.match(/write_version_output\(\) \{[\s\S]*?\n\}\n(?=\nsha=)/)?.[0];
  assert.ok(helper, 'metadata output helper');
  const tempRoot = await mkdtemp(join(tmpdir(), 'happier-npm-metadata-output-'));
  try {
    const githubOutput = join(tempRoot, 'github-output');
    const maliciousVersion = '1.2.3-preview.7\nsha=attacker-controlled';
    const result = spawnSync(
      'bash',
      ['-c', `set -euo pipefail\n${helper}\nwrite_version_output cli_version cli "$MALICIOUS_VERSION"`],
      {
        cwd: new URL('../../', import.meta.url),
        env: {
          ...process.env,
          GITHUB_OUTPUT: githubOutput,
          INPUT_CHANNEL: 'preview',
          MALICIOUS_VERSION: maliciousVersion,
        },
        encoding: 'utf8',
      },
    );
    assert.notEqual(result.status, 0, 'malicious version must fail before output');
    const emitted = await readFile(githubOutput, 'utf8').catch(() => '');
    assert.equal(emitted, '', 'malicious version must not forge any GitHub output');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  const { validateCandidateVersions } = await import(
    '../pipeline/release/verify-release-candidate-identity.mjs'
  );
  for (const productId of ['cli', 'stack', 'server']) {
    assert.throws(
      () => validateCandidateVersions({
        channel: 'preview',
        versions: { [productId]: '1.2.3-preview.7\nsha=attacker-controlled' },
      }),
      /Invalid version|must match/,
      `${productId} metadata must reject a forged output line`,
    );
  }
});

test('preview npm metadata extractors execute as valid JavaScript for every product', async () => {
  const workflow = await loadWorkflow();
  const metadata = workflow.jobs?.release?.steps?.find((step) => step.name === 'Release metadata');
  const source = String(metadata?.run ?? '');
  const versions = {
    cli: '0.2.11-preview.1',
    stack: '0.2.11-preview.2',
    server: '0.2.11-preview.3',
  };

  for (const [productId, expected] of Object.entries(versions)) {
    const assignment = new RegExp(
      `${productId}_version="\\$\\(node -e '([^']+)' "\\$\\{versions_json\\}"\\)"`,
    ).exec(source);
    assert.ok(assignment, `missing ${productId} preview version extractor`);
    const result = spawnSync(process.execPath, ['-e', assignment[1], JSON.stringify(versions)], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${productId} extractor failed: ${result.stderr}`);
    assert.equal(result.stdout, expected);
  }
});
