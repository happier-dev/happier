import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);

function workflow(name) {
  return YAML.parse(readFileSync(resolve(repoRoot, '.github/workflows', name), 'utf8'));
}

function reachableWorkflowNames(entrypoints) {
  const pending = [...entrypoints];
  const reachable = new Set();
  while (pending.length > 0) {
    const name = pending.shift();
    if (!name || reachable.has(name)) continue;
    reachable.add(name);
    for (const job of Object.values(workflow(name).jobs ?? {})) {
      const uses = typeof job?.uses === 'string' ? job.uses : '';
      const prefix = './.github/workflows/';
      if (uses.startsWith(prefix)) pending.push(uses.slice(prefix.length));
    }
  }
  return reachable;
}

function needs(job) {
  if (Array.isArray(job?.needs)) return job.needs;
  return job?.needs ? [job.needs] : [];
}

function renderConcurrencyGroup(template, { repository, channel, ref }) {
  return template
    .replaceAll('${{ github.repository }}', repository)
    .replaceAll('${{ inputs.channel }}', channel)
    .replaceAll('${{ github.ref }}', ref);
}

test('the full hosted release binds one exact candidate SHA and publishes runtime before deploying that exact SHA', () => {
  const release = workflow('release.yml');
  const candidate = release.jobs.prepare_release_candidate;
  assert.ok(candidate, 'release workflow must bind the post-promotion candidate source once');
  assert.ok(candidate.outputs.source_sha);

  const publisher = release.jobs.publish_server_runtime;
  const deploy = release.jobs.deploy_server;
  assert.ok(needs(publisher).includes('prepare_release_candidate'));
  assert.ok(needs(deploy).includes('prepare_release_candidate'));
  assert.ok(needs(deploy).includes('promote_server_runtime'));
  assert.equal(
    publisher.with.authorized_sha,
    '${{ needs.prepare_release_candidate.outputs.source_sha }}',
  );
  assert.equal(
    deploy.with.source_ref,
    '${{ needs.prepare_release_candidate.outputs.source_sha }}',
  );
});

test('every GitHub App token reachable from full or nightly release declares repository and permission scope', () => {
  const reachable = reachableWorkflowNames(['release.yml', 'nightly-dev.yml']);
  for (const name of reachable) {
    const parsed = workflow(name);
    for (const [jobName, job] of Object.entries(parsed.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses !== 'actions/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547') continue;
        assert.ok(step.with?.owner, `${name}/${jobName}/${step.name} must scope owner`);
        assert.ok(step.with?.repositories, `${name}/${jobName}/${step.name} must scope repositories`);
        const permissions = Object.keys(step.with ?? {}).filter((key) => key.startsWith('permission-'));
        assert.ok(permissions.length > 0, `${name}/${jobName}/${step.name} must scope permissions`);
      }
    }
  }
});

test('previously broad release-path tokens use the minimum current-repository contents permission', () => {
  const expected = new Map([
    ['promote-branch.yml/promote/Create GitHub App token', 'write'],
    ['promote-ui.yml/promote/Create GitHub App token', 'write'],
    ['promote-website.yml/promote/Create GitHub App token', 'write'],
    ['promote-docs.yml/promote/Create GitHub App token', 'write'],
    ['publish-docker.yml/publish/Create GitHub App token', 'read'],
    ['build-ui-mobile-local.yml/build_android/Create GitHub App token (APK publishing)', 'write'],
    ['publish-ui-mobile-dev.yml/publish/Create GitHub App token', 'read'],
    ['publish-ui-mobile-dev.yml/ios_cloud/Create GitHub App token', 'read'],
    ['publish-ui-mobile-dev.yml/ios_local/Create GitHub App token', 'read'],
  ]);
  const reachable = reachableWorkflowNames(['release.yml', 'nightly-dev.yml']);
  const observed = new Set();
  for (const name of reachable) {
    const parsed = workflow(name);
    for (const [jobName, job] of Object.entries(parsed.jobs)) {
      for (const step of job.steps ?? []) {
        const key = `${name}/${jobName}/${step.name}`;
        if (!expected.has(key)) continue;
        observed.add(key);
        assert.equal(step.uses, 'actions/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547');
        assert.equal(step.with.owner, '${{ github.repository_owner }}');
        assert.equal(step.with.repositories, '${{ github.event.repository.name }}');
        assert.equal(step.with['permission-contents'], expected.get(key));
        assert.deepEqual(
          Object.keys(step.with).filter((field) => field.startsWith('permission-')),
          ['permission-contents'],
          `${key} must not request additional App permissions`,
        );
      }
    }
  }
  assert.deepEqual(observed, new Set(expected.keys()));
});

test('npm publication does not own CLI GitHub immutable or rolling releases', () => {
  const parsed = workflow('release-npm.yml');
  const mirrorJobs = Object.entries(parsed.jobs).filter(([, job]) =>
    job?.uses === './.github/workflows/publish-github-release.yml',
  );
  assert.deepEqual(
    mirrorJobs,
    [],
    'release-npm must publish npm packages only; CLI GitHub tags/assets belong to publish-cli-binaries',
  );
  assert.ok(parsed.jobs['publish-cli'], 'npm CLI package publication must remain active');
});

test('signed rolling publishers serialize one repository/product/channel writer across workflow refs', () => {
  const publishers = [
    ['publish-cli-binaries.yml', 'publish-cli-binaries'],
    ['publish-hstack-binaries.yml', 'publish-hstack-binaries'],
    ['publish-server-runtime.yml', 'publish-server-runtime'],
    ['publish-ui-web.yml', 'publish-ui-web'],
  ];
  const previewGroups = [];

  for (const [workflowName, product] of publishers) {
    const concurrency = workflow(workflowName).concurrency;
    assert.equal(
      concurrency.group,
      `${product}-\${{ github.repository }}-\${{ inputs.channel }}`,
      `${workflowName} must key its only rolling writer by repository, product, and channel`,
    );
    assert.equal(
      concurrency['cancel-in-progress'],
      false,
      `${workflowName} must queue an in-flight same-channel publisher rather than cancel it`,
    );

    const base = {
      repository: 'happier-dev/happier',
      channel: 'preview',
    };
    const mainGroup = renderConcurrencyGroup(concurrency.group, {
      ...base,
      ref: 'refs/heads/main',
    });
    const retryRefGroup = renderConcurrencyGroup(concurrency.group, {
      ...base,
      ref: 'refs/heads/retry-release',
    });
    assert.equal(
      retryRefGroup,
      mainGroup,
      `${workflowName} permits concurrent writers for one channel when workflow refs differ`,
    );
    assert.notEqual(
      renderConcurrencyGroup(concurrency.group, {
        repository: base.repository,
        channel: 'stable',
        ref: 'refs/heads/main',
      }),
      mainGroup,
      `${workflowName} must keep channels independently serialized`,
    );
    previewGroups.push(mainGroup);
  }

  assert.equal(
    new Set(previewGroups).size,
    publishers.length,
    'each signed product must retain its own repository/channel writer group',
  );
});

test('every publish-server-runtime job sets up Node before its first repository script', () => {
  const parsed = workflow('publish-server-runtime.yml');
  for (const [jobName, job] of Object.entries(parsed.jobs)) {
    const steps = job.steps ?? [];
    const firstScript = steps.findIndex((step) => typeof step.run === 'string' && /node scripts\/pipeline\//.test(step.run));
    if (firstScript < 0) continue;
    const setupNode = steps.findIndex((step) => step.uses === 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020');
    assert.ok(setupNode >= 0 && setupNode < firstScript, `${jobName} runs a repository script before setup-node`);
  }
});

test('server runtime publisher exposes a hosted same-version rolling recovery path', () => {
  const parsed = workflow('publish-server-runtime.yml');
  assert.ok(parsed.on.workflow_dispatch.inputs.retry_version);
  assert.ok(parsed.on.workflow_call.inputs.retry_version);
  assert.match(parsed.jobs.release_actor_guard.steps.at(-1).run, /--phase "\$PHASE"/);
  assert.match(parsed.jobs.release_actor_guard.steps.at(-1).run, /--version "\$RETRY_VERSION"/);
  assert.equal(parsed.jobs.build_candidate.if, "${{ inputs.retry_version == '' }}");
  assert.equal(parsed.jobs.finalize_publish.if, "${{ inputs.retry_version == '' }}");
  assert.equal(parsed.jobs.promote_existing.if, "${{ inputs.retry_version != '' }}");
  assert.equal(
    parsed.jobs.promote_existing.outputs.requires_fresh_runner_retry,
    '${{ steps.promote.outputs.requires_fresh_runner_retry }}',
  );
  const bindSource = parsed.jobs.release_actor_guard.steps.find((step) => step.id === 'source');
  assert.equal(bindSource.env.RETRY_VERSION, '${{ inputs.retry_version }}');
  assert.match(bindSource.run, /SOURCE_REF="refs\/tags\/server-v\$RETRY_VERSION"/);
  assert.doesNotMatch(bindSource.run, /steps\.channel_meta\.outputs\.source_ref.*RETRY_VERSION/s);
  const firstPromotion = parsed.jobs.promote_existing.steps.at(-1);
  assert.equal(firstPromotion.id, 'promote');
  assert.match(
    firstPromotion.run,
    /--phase promote-rolling[\s\S]*--authorized-sha "\$AUTHORIZED_SHA"[\s\S]*--version "\$VERSION"/,
  );
  assert.match(firstPromotion.run, /if \[ "\$status" -eq 75 \]/);
  assert.match(firstPromotion.run, /requires_fresh_runner_retry=true/);
  assert.match(firstPromotion.run, /exit "\$status"/);

  const freshRunnerRetry = parsed.jobs.promote_existing_fresh_runner_retry;
  assert.deepEqual(
    freshRunnerRetry.needs,
    ['trusted_ref_guard', 'release_actor_guard', 'promote_existing'],
  );
  assert.equal(
    freshRunnerRetry.if,
    "${{ inputs.retry_version != '' && needs.promote_existing.outputs.requires_fresh_runner_retry == 'true' }}",
  );
  assert.match(
    freshRunnerRetry.steps.at(-1).run,
    /--phase promote-rolling[\s\S]*--authorized-sha "\$AUTHORIZED_SHA"[\s\S]*--version "\$VERSION"/,
  );
});

for (const [workflowName, leafScript] of [
  ['publish-cli-binaries.yml', 'publish-cli-binaries.mjs'],
  ['publish-hstack-binaries.yml', 'publish-hstack-binaries.mjs'],
  ['publish-ui-web.yml', 'publish-ui-web.mjs'],
]) {
  test(`${workflowName} exposes the same hosted retry_version recovery contract`, () => {
    const parsed = workflow(workflowName);
    assert.ok(parsed.on.workflow_dispatch.inputs.retry_version);
    assert.ok(parsed.on.workflow_call.inputs.retry_version);
    if (workflowName === 'publish-ui-web.yml') {
      assert.equal(parsed.jobs.publish.if, "${{ inputs.retry_version == '' }}");
    } else {
      for (const jobName of ['prepare', 'build_candidate', 'finalize_darwin', 'finalize_publish']) {
        assert.equal(
          parsed.jobs[jobName].if,
          "${{ inputs.retry_version == '' }}",
          `${workflowName} ${jobName} must be unreachable during rolling recovery`,
        );
      }
    }
    assert.equal(parsed.jobs.promote_existing.if, "${{ inputs.retry_version != '' }}");
    const recoverySteps = parsed.jobs.promote_existing.steps;
    const recoveryRun = recoverySteps
      .map((step) => String(step.run ?? ''))
      .find((run) => run.includes(leafScript));
    assert.ok(recoveryRun, `recovery job must invoke ${leafScript}`);
    assert.match(recoveryRun, /--phase promote-rolling/);
    assert.match(recoveryRun, /--version "\$RETRY_VERSION"/);
    assert.match(recoveryRun, /--authorized-sha "\$AUTHORIZED_SHA"/);
    assert.doesNotMatch(recoveryRun, /build-|prepare-|MINISIGN_SECRET_KEY/);
    const prefix = {
      'publish-cli-binaries.yml': 'cli-v',
      'publish-hstack-binaries.yml': 'stack-v',
      'publish-ui-web.yml': 'ui-web-v',
    }[workflowName];
    const identityRun = recoverySteps
      .map((step) => String(step.run ?? ''))
      .find((run) => run.includes('resolve-authorized-release-source.mjs'));
    assert.ok(identityRun, 'recovery must use the trusted remote source resolver');
    assert.match(identityRun, new RegExp(`refs/tags/${prefix}\\$\\{?RETRY_VERSION\\}?`));
    assert.equal(
      recoverySteps.filter((step) => step.uses === 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262').length,
      1,
      'recovery must execute only trusted workflow control bytes, not version-tag source bytes',
    );
    assert.ok(
      recoverySteps
        .filter((step) => step.uses === 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262')
        .every((step) => step.with?.['persist-credentials'] === false),
    );
  });
}
