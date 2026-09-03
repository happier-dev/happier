import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function loadWorkflow(name) {
  return readFile(join(repoRoot, '.github', 'workflows', name), 'utf8');
}

test('publish-docker supports workflow_call and is wired from release workflow', async () => {
  const publishDocker = await loadWorkflow('publish-docker.yml');
  assert.match(publishDocker, /\n\s*workflow_call:\n/);
  assert.match(
    publishDocker,
    /permissions:\n\s+contents:\s+read/m,
    'publish-docker should default to read-only contents access',
  );
  assert.match(publishDocker, /\n\s*source_ref:\n/);
  assert.match(
    publishDocker,
    /\n\s*registries:\n/,
    'publish-docker should support configuring which registries receive image pushes',
  );
  assert.match(publishDocker, /\n\s*build_relay:\n/);
  assert.match(publishDocker, /\n\s*build_dev_box:\n/);
  assert.match(publishDocker, /\n\s*server_version:\n/);
  assert.match(publishDocker, /\n\s*cli_version:\n/);
  assert.match(publishDocker, /HAPPIER_DOCKER_SERVER_VERSION:\s*\${{\s*inputs\.server_version\s*}}/);
  assert.match(publishDocker, /HAPPIER_DOCKER_CLI_VERSION:\s*\${{\s*inputs\.cli_version\s*}}/);
  assert.match(
    publishDocker,
    /node "\$GITHUB_WORKSPACE\/scripts\/pipeline\/docker\/publish-images\.mjs"/,
    'publish-docker should delegate docker build+push to the trusted pipeline Docker publisher',
  );
  assert.match(publishDocker, /REGISTRIES:\s*\${{\s*inputs\.registries\s*}}[\s\S]*?--registries "\$REGISTRIES"/);
  assert.match(
    publishDocker,
    /DOCKERHUB_USERNAME:\s*\${{\s*secrets\.DOCKERHUB_USERNAME\s*}}/,
    'publish-docker should pass Docker Hub username to the pipeline script',
  );
  assert.match(
    publishDocker,
    /DOCKERHUB_TOKEN:\s*\${{\s*secrets\.DOCKERHUB_TOKEN\s*}}/,
    'publish-docker should pass Docker Hub token to the pipeline script',
  );
  assert.match(
    publishDocker,
    /Login to GHCR/,
    'publish-docker should login to GHCR (ghcr.io)',
  );
  assert.match(
    publishDocker,
    /registry:\s*ghcr\.io/,
    'publish-docker should use docker/login-action registry ghcr.io',
  );
  assert.match(
    publishDocker,
    /peter-evans\/dockerhub-description@/,
    'publish-docker should publish Docker Hub README/description',
  );
  assert.match(
    publishDocker,
    /repository:\s*happierdev\/relay-server/,
    'publish-docker should publish relay-server Docker Hub README',
  );
  assert.match(
    publishDocker,
    /readme-filepath:\s*\.candidate-source\/docker\/dockerhub\/relay-server\.md/,
    'publish-docker should use repo README file for relay-server',
  );
  assert.match(
    publishDocker,
    /repository:\s*happierdev\/dev-box/,
    'publish-docker should publish dev-box Docker Hub README',
  );
  assert.match(
    publishDocker,
    /readme-filepath:\s*\.candidate-source\/docker\/dockerhub\/dev-box\.md/,
    'publish-docker should use repo README file for dev-box',
  );

  const release = await loadWorkflow('release.yml');
  const releaseWorkflow = YAML.parse(release);
  assert.match(release, /publish_docker:/);
  assert.match(release, /publish_cli_binaries:/);
  assert.match(
    release,
    /publish_server_runtime_needed:\s*\$\{\{[^\n]*inputs\.force_deploy == true[^\n]*steps\.bump_plan\.outputs\.publish_server == 'true'[^\n]*steps\.plan\.outputs\.changed_ui == 'true'[^\n]*steps\.plan\.outputs\.changed_server == 'true'[^\n]*steps\.plan\.outputs\.changed_shared == 'true'[^\n]*\}\}[\s\S]*?publish_server_runtime:[\s\S]*?needs\.plan\.outputs\.publish_server_runtime_needed == 'true'/,
    'server runtime artifacts should publish when server code or its embedded UI changes',
  );
  assert.match(releaseWorkflow.jobs.plan.outputs.publish_ui_web_needed, /inputs\.deploy_targets/);
  assert.match(releaseWorkflow.jobs.plan.outputs.publish_ui_web_needed, /steps\.plan\.outputs\.changed_ui == 'true'/);
  assert.match(releaseWorkflow.jobs.publish_ui_web.if, /needs\.plan\.outputs\.publish_ui_web_needed == 'true'/);
  assert.match(release, /uses:\s+\.\/\.github\/workflows\/publish-docker\.yml/);
  assert.deepEqual(releaseWorkflow.jobs.publish_docker.needs, ['resolve_resume', 'plan', 'promote_preview', 'promote_main', 'prepare_release_candidate', 'verify_release_candidates', 'publish_cli_binaries', 'publish_server_runtime']);
  assert.match(release, /authorized_sha:\s*\${{\s*needs\.prepare_release_candidate\.outputs\.source_sha\s*}}/);
  assert.match(release, /server_version:\s*\${{\s*needs\.publish_server_runtime\.outputs\.version\s*}}/);
  assert.match(release, /cli_version:\s*\${{\s*needs\.publish_cli_binaries\.outputs\.version\s*}}/);
  assert.match(releaseWorkflow.jobs.publish_docker.if, /needs\.verify_release_candidates\.result == 'success'/);
  assert.match(release, /build_relay:/);
  assert.match(release, /build_dev_box:/);
  assert.doesNotMatch(release, /build_dev_box:\s*\$\{\{[^\n]*changed_stack/);
  assert.equal(
    releaseWorkflow.jobs.publish_docker.permissions.packages,
    'write',
    'release must delegate the packages:write permission required by publish-docker',
  );
});

test('nightly dev docker waits for the release artifacts it consumes', async () => {
  const nightly = await loadWorkflow('nightly-dev.yml');
  assert.match(
    nightly,
    /docker:[\s\S]*?needs:\s*\[prepare_release_candidate, cli, server_runtime, release_verify\][\s\S]*?uses:\s+\.\/\.github\/workflows\/publish-docker\.yml/,
  );
  assert.match(nightly, /authorized_sha:\s*\${{\s*needs\.prepare_release_candidate\.outputs\.source_sha\s*}}/);
  assert.match(nightly, /server_version:\s*\${{\s*needs\.server_runtime\.outputs\.version\s*}}/);
  assert.match(nightly, /cli_version:\s*\${{\s*needs\.cli\.outputs\.version\s*}}/);
});

test('Docker publishing runs its dependency-free trusted pipeline without a workspace install', async () => {
  const publishDocker = await loadWorkflow('publish-docker.yml');
  assert.doesNotMatch(publishDocker, /enable-corepack-yarn|install-yarn-dependencies/);
  assert.match(
    publishDocker,
    /Download exact candidate source[\s\S]*?Materialize candidate source as inert build data[\s\S]*?Build & push images \(trusted pipeline\)/,
    'Docker publication should consume the prepared candidate source before invoking its trusted stdlib-only pipeline',
  );
});

test('Docker candidate source is prepared without release or registry secrets', async () => {
  const workflow = YAML.parse(await loadWorkflow('publish-docker.yml'));
  const jobs = workflow.jobs;
  const guard = jobs.trusted_ref_guard;
  const actorGuard = jobs.release_actor_guard;
  const candidate = jobs.prepare_candidate;

  assert.ok(guard, 'Docker publishing must reject untrusted called-workflow control refs');
  assert.deepEqual(actorGuard.needs, ['trusted_ref_guard']);
  const actorControlCheckout = actorGuard.steps.find(
    (step) => step.name === 'Checkout trusted workflow control bytes',
  );
  assert.equal(actorControlCheckout?.with?.repository, '${{ job.workflow_repository }}');
  assert.equal(actorControlCheckout?.with?.ref, '${{ job.workflow_sha }}');
  assert.equal(actorControlCheckout?.with?.['persist-credentials'], false);
  assert.ok(candidate, 'Docker publishing must prepare candidate source outside the privileged publisher');
  assert.equal(candidate.environment, undefined);
  assert.deepEqual(candidate.permissions, { contents: 'read' });
  assert.deepEqual(candidate.needs, ['release_actor_guard']);
  assert.doesNotMatch(
    JSON.stringify(candidate),
    /DOCKERHUB_TOKEN|GHCR_PAT|GHCR_TOKEN|RELEASE_BOT_PRIVATE_KEY|create-github-app-token|environment:/,
  );

  const controlCheckout = candidate.steps.find((step) => step.name === 'Checkout trusted workflow control bytes');
  assert.equal(controlCheckout?.uses, 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262');
  assert.equal(controlCheckout?.with?.repository, '${{ job.workflow_repository }}');
  assert.equal(controlCheckout?.with?.ref, '${{ job.workflow_sha }}');
  assert.equal(controlCheckout?.with?.['persist-credentials'], false);

  const sourceCheckout = candidate.steps.find((step) => step.name === 'Checkout exact candidate source as inert data');
  assert.equal(sourceCheckout?.uses, 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262');
  assert.equal(sourceCheckout?.with?.path, '.candidate-source');
  assert.equal(sourceCheckout?.with?.repository, '${{ job.workflow_repository }}');
  assert.notEqual(sourceCheckout?.with?.ref, '${{ job.workflow_sha }}');
  assert.equal(sourceCheckout?.with?.['persist-credentials'], false);
  assert.match(JSON.stringify(candidate), /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);

  const stableGuard = candidate.steps.find((step) => step.name === 'Verify stable candidate is current main');
  assert.ok(stableGuard, 'stable Docker admission must compare immutable commit identities');
  assert.match(stableGuard.if, /inputs\.channel == 'stable'/);
  assert.equal(stableGuard.env.SOURCE_SHA, '${{ steps.source.outputs.source_sha }}');
  assert.match(stableGuard.run, /git ls-remote --exit-code origin refs\/heads\/main/);
  assert.match(stableGuard.run, /test "\$SOURCE_SHA" = "\$main_sha"/);
  assert.doesNotMatch(
    JSON.stringify(candidate),
    /source_ref != 'main'/,
    'an exact resumed SHA must not be rejected merely because its ref spelling is not main',
  );
});

test('Docker publication requires exact artifact versions for every selected image', async () => {
  const workflow = YAML.parse(await loadWorkflow('publish-docker.yml'));
  const guard = workflow.jobs?.trusted_ref_guard;
  assert.ok(guard, 'expected the secret-free Docker admission guard');

  const serialized = JSON.stringify(guard);
  assert.match(serialized, /inputs\.build_relay/);
  assert.match(serialized, /inputs\.server_version/);
  assert.match(serialized, /inputs\.build_dev_box/);
  assert.match(serialized, /inputs\.cli_version/);
  assert.match(serialized, /server artifact version is required/i);
  assert.match(serialized, /CLI artifact version is required/i);
});

test('Docker registry publisher executes trusted control only and consumes the exact candidate artifact as data', async () => {
  const workflow = YAML.parse(await loadWorkflow('publish-docker.yml'));
  const jobs = workflow.jobs;
  const publish = jobs.publish;

  assert.ok(publish);
  assert.deepEqual(publish.needs, ['prepare_candidate']);
  assert.equal(publish.environment, 'release-shared');
  assert.deepEqual(publish.permissions, { contents: 'read', packages: 'write' });

  const controlCheckout = publish.steps.find((step) => step.name === 'Checkout trusted workflow control bytes');
  assert.equal(controlCheckout?.uses, 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262');
  assert.equal(controlCheckout?.with?.repository, '${{ job.workflow_repository }}');
  assert.equal(controlCheckout?.with?.ref, '${{ job.workflow_sha }}');
  assert.equal(controlCheckout?.with?.['persist-credentials'], false);

  const appToken = publish.steps.find((step) => step.name === 'Create GitHub App token');
  assert.equal(appToken?.uses, 'actions/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547');
  assert.equal(appToken?.with?.owner, '${{ github.repository_owner }}');
  assert.equal(appToken?.with?.repositories, '${{ github.event.repository.name }}');
  assert.equal(appToken?.with?.['permission-contents'], 'read');

  const serialized = JSON.stringify(publish);
  assert.match(serialized, /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/);
  assert.match(serialized, /needs\.prepare_candidate\.outputs\.source_sha/);
  assert.doesNotMatch(serialized, /"uses":"\.\/\.candidate-source/);
  assert.doesNotMatch(serialized, /node \.candidate-source|yarn --cwd \.candidate-source/);

  const publisher = publish.steps.find((step) => step.name === 'Build & push images (trusted pipeline)');
  assert.equal(publisher?.['working-directory'], '.candidate-source');
  assert.match(publisher?.run ?? '', /node "\$GITHUB_WORKSPACE\/scripts\/pipeline\/docker\/publish-images\.mjs"/);
  assert.match(publisher?.run ?? '', /--sha "\$SOURCE_SHA"/);
  assert.doesNotMatch(publisher?.run ?? '', /\$\{\{\s*inputs\./);

  for (const step of publish.steps) {
    if (typeof step.run === 'string') {
      assert.doesNotMatch(step.run, /\$\{\{\s*inputs\./, `${step.name ?? 'run'} interpolates input into shell`);
    }
  }
  for (const [jobName, job] of Object.entries(jobs)) {
    for (const step of job.steps ?? []) {
      if (typeof step.run === 'string') {
        assert.doesNotMatch(step.run, /\$\{\{\s*inputs\./, `${jobName}/${step.name ?? 'run'} interpolates input into shell`);
      }
    }
  }
});
