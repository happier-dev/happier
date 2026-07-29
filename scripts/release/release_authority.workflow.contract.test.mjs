import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);

function workflow(name) {
  return YAML.parse(readFileSync(resolve(repoRoot, '.github/workflows', name), 'utf8'));
}

function actionNameFromUse(use) {
  const delimiter = String(use ?? '').lastIndexOf('@');
  return delimiter < 0 ? String(use ?? '') : String(use).slice(0, delimiter);
}

function usesAction(step, actionName) {
  return actionNameFromUse(step?.uses) === actionName;
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

function reachableWorkflowEdges(entrypoints) {
  const reachable = reachableWorkflowNames(entrypoints);
  const edges = [];
  for (const name of reachable) {
    for (const [jobName, job] of Object.entries(workflow(name).jobs ?? {})) {
      const uses = typeof job?.uses === 'string' ? job.uses : '';
      const prefix = './.github/workflows/';
      if (!uses.startsWith(prefix)) continue;
      edges.push({
        caller: name,
        jobName,
        target: uses.slice(prefix.length),
        with: job.with ?? {},
      });
    }
  }
  return edges;
}

function jobNeeds(job) {
  if (Array.isArray(job?.needs)) return job.needs;
  return job?.needs ? [job.needs] : [];
}

function transitivelyNeeds(jobs, jobName, dependency, seen = new Set()) {
  if (seen.has(jobName)) return false;
  seen.add(jobName);
  for (const needed of jobNeeds(jobs[jobName])) {
    if (needed === dependency || transitivelyNeeds(jobs, needed, dependency, seen)) return true;
  }
  return false;
}

const signedPublishers = [
  ['publish-cli-binaries.yml', 'publish-cli-binaries'],
  ['publish-hstack-binaries.yml', 'publish-hstack-binaries'],
  ['publish-server-runtime.yml', 'publish-server-runtime'],
  ['publish-ui-web.yml', 'publish-ui-web'],
];

test('reachable release graph has one CLI GitHub Release writer for every signed CLI tag namespace', () => {
  const reachable = reachableWorkflowNames(['release.yml', 'nightly-dev.yml']);
  assert.ok(reachable.has('publish-cli-binaries.yml'), 'signed CLI publisher must remain reachable');

  const cliTag = /^(?:cli-v|cli-(?:stable|preview|dev))(?:$|\$\{\{)/;
  const competingWriters = reachableWorkflowEdges(['release.yml', 'nightly-dev.yml'])
    .filter((edge) => edge.target === 'publish-github-release.yml')
    .filter((edge) => cliTag.test(String(edge.with.tag ?? '')))
    .map((edge) => ({
      caller: edge.caller,
      job: edge.jobName,
      tag: edge.with.tag,
      clobber: edge.with.clobber,
      prune_assets: edge.with.prune_assets,
    }));

  assert.deepEqual(
    competingWriters,
    [],
    'signed CLI tags must be written only by publish-cli-binaries.yml; remove every reachable generic mirror',
  );
  const npmWorkflow = workflow('release-npm.yml');
  assert.ok(npmWorkflow.jobs['publish-cli'], 'npm CLI package publication must remain active');
  assert.doesNotMatch(
    JSON.stringify(npmWorkflow.jobs.release),
    /GitHub Releases \(mirror\)|cli-preview.*rolling prerelease/,
    'the npm release summary must not claim ownership of deleted CLI GitHub Release mirrors',
  );
});

test('signed publishers bind trusted control checkouts to the called workflow repository and SHA', () => {
  const expectedControlCheckouts = {
    'publish-cli-binaries.yml': {
      release_actor_guard: 'Checkout',
      prepare: 'Checkout workflow repo',
      promote_existing: 'Checkout trusted workflow control bytes',
    },
    'publish-hstack-binaries.yml': {
      release_actor_guard: 'Checkout',
      publish: 'Checkout workflow repo',
      promote_existing: 'Checkout trusted workflow control bytes',
    },
    'publish-ui-web.yml': {
      release_actor_guard: 'Checkout',
      publish: 'Checkout workflow repo',
      promote_existing: 'Checkout trusted workflow control bytes',
    },
    'publish-server-runtime.yml': {
      release_actor_guard: 'Checkout trusted workflow bytes',
      build_candidate: 'Checkout trusted workflow control bytes',
      finalize_publish: 'Checkout trusted workflow control bytes',
      promote_existing: 'Checkout trusted workflow control bytes',
    },
  };

  for (const [name, expectedByJob] of Object.entries(expectedControlCheckouts)) {
    const jobs = workflow(name).jobs;
    const guard = jobs.trusted_ref_guard;
    assert.ok(guard, `${name} must reject untrusted called-workflow control refs`);
    const guardStep = (guard.steps ?? []).find(
      (step) => step.name === 'Reject cross-repository or untrusted workflow control',
    );
    assert.ok(guardStep, `${name} trusted-ref guard step`);
    assert.equal(guardStep.env?.CALLER_REPOSITORY, '${{ github.repository }}');
    assert.equal(guardStep.env?.WORKFLOW_REPOSITORY, '${{ job.workflow_repository }}');
    assert.equal(guardStep.env?.WORKFLOW_REF, '${{ job.workflow_ref }}');
    assert.match(guardStep.run, /test "\$CALLER_REPOSITORY" = "\$WORKFLOW_REPOSITORY"/);
    const guardSource = JSON.stringify(guardStep);
    assert.match(guardSource, /job\.workflow_repository/, `${name} guard workflow repository`);
    assert.match(guardSource, /job\.workflow_ref/, `${name} guard workflow ref`);
    assert.match(guardSource, new RegExp(`${name.replaceAll('.', '\\.')}@refs/heads/(?:dev|preview|main)`));

    for (const [jobName, stepName] of Object.entries(expectedByJob)) {
      const step = (jobs[jobName].steps ?? []).find(
        (candidate) => usesAction(candidate, 'actions/checkout') && candidate.name === stepName,
      );
      assert.ok(step, `${name}/${jobName}/${stepName}`);
      assert.equal(step.with?.repository, '${{ job.workflow_repository }}', `${name}/${jobName} repository`);
      assert.equal(step.with?.ref, '${{ job.workflow_sha }}', `${name}/${jobName} ref`);
      assert.equal(step.with?.['persist-credentials'], false, `${name}/${jobName} credentials`);
      assert.ok(
        transitivelyNeeds(jobs, jobName, 'trusted_ref_guard'),
        `${name}/${jobName} must depend on trusted_ref_guard`,
      );
    }
    assert.doesNotMatch(JSON.stringify(jobs), /github\.workflow_sha/, `${name} must not use caller-scoped workflow SHA`);
  }
});

test('signed publishers keep authorized product source checkouts distinct from control bytes', () => {
  const expectedSourceCheckouts = {
    'publish-cli-binaries.yml': {
      prepare: 'Checkout exact source',
      build_native: 'Checkout exact source',
      finalize_candidate: 'Checkout exact source',
      publish: 'Checkout exact source',
    },
    'publish-hstack-binaries.yml': {
      publish: 'Checkout source ref',
    },
    'publish-ui-web.yml': {
      publish: 'Checkout source ref',
    },
    'publish-server-runtime.yml': {
      build_candidate: 'Checkout source without persisted credentials',
    },
  };

  for (const [name, expectedByJob] of Object.entries(expectedSourceCheckouts)) {
    const jobs = workflow(name).jobs;
    for (const [jobName, stepName] of Object.entries(expectedByJob)) {
      const step = (jobs[jobName].steps ?? []).find(
        (candidate) => usesAction(candidate, 'actions/checkout') && candidate.name === stepName,
      );
      assert.ok(step, `${name}/${jobName}/${stepName}`);
      assert.equal(step.with?.repository, '${{ job.workflow_repository }}');
      assert.notEqual(step.with?.ref, '${{ job.workflow_sha }}');
      assert.match(String(step.with?.ref ?? ''), /source|authorized_sha/);
      assert.equal(step.with?.['persist-credentials'], false);
    }
  }
});

test('signed publishers serialize one repository/product/channel writer across refs', () => {
  for (const [name, product] of signedPublishers) {
    const concurrency = workflow(name).concurrency;
    assert.equal(concurrency.group, `${product}-\${{ github.repository }}-\${{ inputs.channel }}`);
    assert.equal(concurrency['cancel-in-progress'], false);
    assert.doesNotMatch(concurrency.group, /github\.ref/);
  }
});

test('signed publishers expose hosted same-version rolling recovery', () => {
  for (const [name] of signedPublishers) {
    const parsed = workflow(name);
    assert.ok(parsed.on.workflow_dispatch.inputs.retry_version, `${name} dispatch retry_version`);
    assert.ok(parsed.on.workflow_call.inputs.retry_version, `${name} call retry_version`);
    const serialized = JSON.stringify(parsed.jobs);
    assert.match(serialized, /promote-rolling/);
    assert.match(serialized, /authorized-sha/);
    assert.match(serialized, /retry_version/);
  }
});

test('every App token in signed publishers scopes owner, repositories, and contents permission', () => {
  for (const [name] of signedPublishers) {
    for (const [jobName, job] of Object.entries(workflow(name).jobs)) {
      for (const step of job.steps ?? []) {
        if (!usesAction(step, 'actions/create-github-app-token')) continue;
        assert.equal(step.with.owner, '${{ github.repository_owner }}', `${name}/${jobName}`);
        assert.ok(step.with.repositories, `${name}/${jobName}`);
        assert.ok(step.with['permission-contents'], `${name}/${jobName}`);
      }
    }
  }
});

test('every App token reachable from full or nightly release has exact repository and permission scope', () => {
  for (const name of reachableWorkflowNames(['release.yml', 'nightly-dev.yml'])) {
    for (const [jobName, job] of Object.entries(workflow(name).jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (!usesAction(step, 'actions/create-github-app-token')) continue;
        assert.ok(step.with?.owner, `${name}/${jobName}/${step.name} owner`);
        assert.ok(step.with?.repositories, `${name}/${jobName}/${step.name} repositories`);
        assert.ok(
          Object.keys(step.with ?? {}).some((field) => field.startsWith('permission-')),
          `${name}/${jobName}/${step.name} permission`,
        );
      }
    }
  }
});

test('full release binds one server SHA for runtime publication and deployment', () => {
  const jobs = workflow('release.yml').jobs;
  assert.ok(jobs.bind_server_source);
  assert.equal(jobs.publish_server_runtime.with.authorized_sha, '${{ needs.bind_server_source.outputs.authorized_sha }}');
  assert.equal(jobs.deploy_server.with.source_ref, '${{ needs.bind_server_source.outputs.authorized_sha }}');
  const deployNeeds = Array.isArray(jobs.deploy_server.needs) ? jobs.deploy_server.needs : [jobs.deploy_server.needs];
  assert.ok(deployNeeds.includes('publish_server_runtime'));
});

test('server candidate is secret-free and the privileged finalizer consumes only the frozen candidate identity', () => {
  const jobs = workflow('publish-server-runtime.yml').jobs;
  const candidate = jobs.build_candidate;
  const finalizer = jobs.finalize_publish;
  assert.equal(candidate.environment, undefined);
  assert.doesNotMatch(JSON.stringify(candidate), /MINISIGN_SECRET_KEY.*secrets|RELEASE_BOT_PRIVATE_KEY|create-github-app-token/);
  assert.deepEqual(finalizer.needs, ['build_candidate']);
  const finalizerSource = JSON.stringify(finalizer);
  assert.match(finalizerSource, /needs\.build_candidate\.outputs\.source_sha/);
  assert.match(finalizerSource, /needs\.build_candidate\.outputs\.version/);
  assert.match(finalizerSource, /--prepared-artifacts/);
  assert.doesNotMatch(finalizerSource, /steps\.channel_meta\.outputs\.source_ref/);
});

test('CLI candidate finalization cannot write a GitHub Release', () => {
  const jobs = workflow('publish-cli-binaries.yml').jobs;
  const candidate = jobs.finalize_candidate;
  assert.ok(candidate);
  assert.deepEqual(candidate.needs, ['prepare', 'build_native']);
  assert.equal(candidate.permissions?.contents, 'read');
  assert.equal(candidate.permissions?.['id-token'], undefined);
  assert.equal(candidate.permissions?.attestations, undefined);
  assert.equal(
    (candidate.steps ?? []).some(
      (step) => usesAction(step, 'actions/create-github-app-token'),
    ),
    false,
  );
  const candidateSource = JSON.stringify(candidate);
  assert.doesNotMatch(candidateSource, /GH_TOKEN|publish-cli-binaries|publish-release|promote-rolling/);
  assert.match(candidateSource, /finalize-prepared-only/);
  assert.match(candidateSource, /actions\/upload-artifact/);
});
