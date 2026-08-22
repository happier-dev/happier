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
      attest_native: 'Checkout trusted workflow control bytes',
      finalize_darwin: 'Checkout trusted workflow control bytes',
      finalize_candidate: 'Checkout trusted workflow control bytes',
      admit_publication: 'Checkout trusted workflow control bytes',
      publish: 'Checkout trusted workflow control bytes',
      promote_existing: 'Checkout trusted workflow control bytes',
    },
    'publish-hstack-binaries.yml': {
      release_actor_guard: 'Checkout',
      prepare: 'Checkout trusted workflow control bytes',
      finalize_darwin: 'Checkout trusted workflow control bytes',
      finalize_publish: 'Checkout trusted workflow control bytes',
      promote_existing: 'Checkout trusted workflow control bytes',
    },
    'publish-ui-web.yml': {
      release_actor_guard: 'Checkout',
      prepare: 'Checkout trusted workflow control bytes',
      publish: 'Checkout trusted workflow control bytes',
      promote_existing: 'Checkout trusted workflow control bytes',
    },
    'publish-server-runtime.yml': {
      release_actor_guard: 'Checkout trusted workflow bytes',
      prepare: 'Checkout trusted workflow control bytes',
      finalize_darwin: 'Checkout trusted workflow control bytes',
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
      prepare: 'Checkout exact source as inert data',
    },
    'publish-hstack-binaries.yml': {
      prepare: 'Checkout exact source as inert data',
    },
    'publish-ui-web.yml': {
      prepare: 'Checkout exact source as inert data',
    },
    'publish-server-runtime.yml': {
      prepare: 'Checkout exact source as inert data',
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
      assert.equal(step.with?.path, '.candidate-source', `${name}/${jobName} inert source path`);
    }
  }
});

test('HStack and server candidate builders consume inert source artifacts without repository authority', () => {
  for (const [name, sourceArtifactPrefix] of [
    ['publish-hstack-binaries.yml', 'hstack-source-'],
    ['publish-server-runtime.yml', 'server-runtime-source-'],
  ]) {
    const jobs = workflow(name).jobs;
    const prepare = jobs.prepare;
    const build = jobs.build_candidate;
    assert.ok(prepare, `${name} trusted prepare job`);
    assert.ok(build, `${name} candidate builder`);
    assert.deepEqual(build.permissions, {}, `${name} candidate builder permissions`);
    assert.equal(
      (build.steps ?? []).some((step) => usesAction(step, 'actions/checkout')),
      false,
      `${name} candidate builder must not have repository checkout authority`,
    );
    const buildSource = JSON.stringify(build);
    assert.match(buildSource, new RegExp(`${sourceArtifactPrefix}.*needs\\.prepare\\.outputs\\.source_sha`));
    assert.match(buildSource, /Download exact candidate source transport/);
    assert.match(buildSource, /Materialize candidate source without repository authority/);
    assert.match(
      buildSource,
      /verify-artifacts\.mjs[\s\S]*?--require-all-archives-checksummed[\s\S]*?find dist\/release-assets\/[^ ]+ -type f ! -name '\*\.tar\.gz' -delete/,
      `${name} must retain archive admission and compatible-platform smoke before its unsigned handoff`,
    );
    assert.doesNotMatch(
      buildSource,
      /github\.token|GH_TOKEN|GITHUB_TOKEN|id-token|attestations|artifact-metadata|secrets\./,
      `${name} candidate-controlled code must have no repository, provenance, signing, or publication authority`,
    );

    const sourceCheckout = prepare.steps.find(
      (step) => step.name === 'Checkout exact source as inert data',
    );
    assert.equal(sourceCheckout?.with?.path, '.candidate-source');
    const trustedCheckout = prepare.steps.find(
      (step) => step.name === 'Checkout trusted workflow control bytes',
    );
    assert.equal(trustedCheckout?.with?.ref, '${{ job.workflow_sha }}');
    assert.equal(trustedCheckout?.with?.path, undefined);
  }
});

test('HStack and server allocate from exact canonical candidate base versions using trusted control bytes', async () => {
  const { normalizeRollingBaseVersion } = await import(
    '../pipeline/release/lib/rolling-version-allocation.mjs'
  );
  for (const maliciousVersion of [
    '1.2.3\nmalicious_key=$(touch /tmp/happier-release-pwned)',
    '1.2.3; touch /tmp/happier-release-pwned',
  ]) {
    assert.throws(() => normalizeRollingBaseVersion(maliciousVersion), /Invalid version/);
  }

  for (const [name, packagePath] of [
    ['publish-hstack-binaries.yml', '.candidate-source/apps/stack/package.json'],
    ['publish-server-runtime.yml', '.candidate-source/apps/server/package.json'],
  ]) {
    const prepare = workflow(name).jobs.prepare;
    const readBaseVersion = prepare.steps.find(
      (step) => step.name === 'Read candidate base version as data',
    );
    assert.ok(readBaseVersion, `${name} candidate base-version reader`);
    const readRun = String(readBaseVersion.run ?? '');
    assert.match(readRun, /normalizeRollingBaseVersion/);
    assert.match(readRun, /normalizeRollingBaseVersion\(value\)\s*!==\s*value/);
    assert.match(readRun, new RegExp(packagePath.replaceAll('.', '\\.').replaceAll('/', '\\/')));
    assert.doesNotMatch(readRun, /\.candidate-source\/scripts/);

    const allocate = prepare.steps.find((step) => step.name === 'Allocate immutable version');
    assert.equal(
      allocate?.env?.CANDIDATE_BASE_VERSION,
      '${{ steps.candidate_base.outputs.base_version }}',
    );
    assert.match(String(allocate?.run ?? ''), /--base-version "\$CANDIDATE_BASE_VERSION"/);
    assert.doesNotMatch(
      String(allocate?.run ?? ''),
      /\$\{\{\s*steps\.candidate_base\.outputs\.base_version\s*\}\}/,
    );
    assert.equal(prepare.outputs?.base_version, '${{ steps.candidate_base.outputs.base_version }}');
    const finalize = workflow(name).jobs.finalize_publish;
    const publisher = finalize.steps.find((step) => String(step.run ?? '').includes('--prepared-artifacts'));
    assert.equal(
      publisher?.env?.CANDIDATE_BASE_VERSION,
      '${{ needs.prepare.outputs.base_version }}',
    );
    assert.match(String(publisher?.run ?? ''), /--base-version "\$CANDIDATE_BASE_VERSION"/);
    assert.match(
      String(publisher?.run ?? ''),
      /--skip-smoke/,
      `${name} privileged publisher must not execute candidate binaries`,
    );
  }
});

test('standalone publisher credential-bearing shells receive untrusted values only through env', async () => {
  const maliciousReleaseMessage = 'notes"; touch /tmp/happier-release-pwned; #\nnext=value';
  assert.match(maliciousReleaseMessage, /[";\n]/, 'fixture must remain shell-significant');
  const { parsePublishBinaryReleaseArgs } = await import(
    '../pipeline/release/publishing/publish-binary-release.mjs'
  );
  assert.equal(
    parsePublishBinaryReleaseArgs(['--release-message', maliciousReleaseMessage])['release-message'],
    maliciousReleaseMessage,
    'the publisher receives a shell-significant release message as one inert argv value',
  );

  for (const name of [
    'publish-cli-binaries.yml',
    'publish-hstack-binaries.yml',
    'publish-server-runtime.yml',
  ]) {
    const jobs = workflow(name).jobs;
    for (const [jobName, job] of Object.entries(jobs)) {
      for (const step of job.steps ?? []) {
        if (!step.run) continue;
        const credentialEnvKeys = Object.keys(step.env ?? {}).filter((key) => (
          key === 'GH_TOKEN'
          || key === 'GITHUB_TOKEN'
          || key.startsWith('APPLE_')
          || key.startsWith('MINISIGN_')
        ));
        if (credentialEnvKeys.length === 0) continue;
        const run = String(step.run);
        assert.doesNotMatch(
          run,
          /\$\{\{\s*inputs\./,
          `${name}/${jobName}/${step.name} must not expression-interpolate workflow inputs into shell source`,
        );
        assert.doesNotMatch(
          run,
          /\$\{\{\s*needs\.[^}]*\.outputs\./,
          `${name}/${jobName}/${step.name} must not expression-interpolate candidate outputs into shell source`,
        );
      }
    }

    for (const jobName of ['finalize_publish', 'publish', 'promote_existing']) {
      const job = jobs[jobName];
      if (!job) continue;
      for (const step of job.steps ?? []) {
        if (!String(step.run ?? '').includes('--release-message')) continue;
        assert.equal(step.env?.RELEASE_MESSAGE, '${{ inputs.release_message }}');
        assert.match(String(step.run), /--release-message "\$RELEASE_MESSAGE"/);
        assert.doesNotMatch(String(step.run), /inputs\.release_message/);
      }
    }
  }
});

test('standalone publisher shell bodies contain no GitHub expression interpolation', () => {
  for (const name of [
    'publish-cli-binaries.yml',
    'publish-hstack-binaries.yml',
    'publish-server-runtime.yml',
  ]) {
    for (const [jobName, job] of Object.entries(workflow(name).jobs)) {
      for (const step of job.steps ?? []) {
        if (!step.run) continue;
        assert.doesNotMatch(
          String(step.run),
          /\$\{\{/,
          `${name}/${jobName}/${step.name} must receive dynamic values through env, not shell-source interpolation`,
        );
      }
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

test('full release binds one candidate SHA for runtime publication and deployment', () => {
  const jobs = workflow('release.yml').jobs;
  assert.ok(jobs.prepare_release_candidate);
  assert.equal(jobs.publish_server_runtime.with.authorized_sha, '${{ needs.prepare_release_candidate.outputs.source_sha }}');
  assert.equal(jobs.deploy_server.with.source_ref, '${{ needs.prepare_release_candidate.outputs.source_sha }}');
  const deployNeeds = Array.isArray(jobs.deploy_server.needs) ? jobs.deploy_server.needs : [jobs.deploy_server.needs];
  assert.ok(deployNeeds.includes('promote_server_runtime'));
});

test('preview release forwards one complete CLI candidate identity and binds it to the promoted source', () => {
  const parsed = workflow('release.yml');
  const inputs = parsed.on.workflow_dispatch.inputs;
  for (const inputName of ['candidate_run_id', 'candidate_version', 'candidate_source_sha']) {
    assert.equal(inputs[inputName]?.required, false, `${inputName} must remain optional for ordinary releases`);
    assert.equal(inputs[inputName]?.default, '', `${inputName} must preserve the ordinary fresh-build path`);
  }
  const jobs = parsed.jobs;
  assert.match(
    jobs.plan.outputs.publish_cli_binaries_needed,
    /inputs\.candidate_run_id != ''/,
    'selecting a candidate must not be silently ignored when no CLI diff is detected',
  );
  const inputValidation = jobs.ci.steps.find((step) => step.name === 'Validate release dispatch');
  assert.ok(inputValidation, 'release input validation step');
  assert.match(inputValidation.run, /validate-release-dispatch\.mjs/);

  const sourceBinding = jobs.prepare_release_candidate.steps.find(
    (step) => step.name === 'Resolve promoted branch once',
  );
  assert.equal(sourceBinding.env.CANDIDATE_SOURCE_SHA, '${{ inputs.candidate_source_sha }}');
  assert.match(sourceBinding.run, /\[ "\$CANDIDATE_SOURCE_SHA" != "\$source_sha" \]/);
  assert.match(sourceBinding.run, /CLI candidate source does not match the promoted preview source/);

  const cliPublisher = jobs.publish_cli_binaries;
  assert.equal(cliPublisher.permissions.actions, 'read');
  assert.equal(cliPublisher.with.candidate_run_id, '${{ inputs.candidate_run_id }}');
  assert.equal(cliPublisher.with.candidate_version, '${{ inputs.candidate_version }}');
  assert.equal(cliPublisher.with.candidate_source_sha, '${{ inputs.candidate_source_sha }}');
  assert.equal(
    cliPublisher.with.authorized_sha,
    '${{ needs.prepare_release_candidate.outputs.source_sha }}',
  );
});

test('server candidate is secret-free and the privileged finalizer consumes only the frozen candidate identity', () => {
  const jobs = workflow('publish-server-runtime.yml').jobs;
  const candidate = jobs.build_candidate;
  const finalizer = jobs.finalize_publish;
  assert.equal(candidate.environment, undefined);
  assert.doesNotMatch(JSON.stringify(candidate), /MINISIGN_SECRET_KEY.*secrets|RELEASE_BOT_PRIVATE_KEY|create-github-app-token/);
  assert.deepEqual(finalizer.needs, ['prepare', 'build_candidate', 'finalize_darwin']);
  const darwinFinalizer = jobs.finalize_darwin;
  assert.deepEqual(darwinFinalizer.needs, ['prepare', 'build_candidate']);
  assert.match(JSON.stringify(darwinFinalizer), /needs\.prepare\.outputs\.source_sha/);
  const finalizerSource = JSON.stringify(finalizer);
  assert.match(finalizerSource, /needs\.prepare\.outputs\.source_sha/);
  assert.match(finalizerSource, /needs\.prepare\.outputs\.version/);
  assert.match(finalizerSource, /--prepared-artifacts/);
  assert.doesNotMatch(finalizerSource, /steps\.channel_meta\.outputs\.source_ref/);
});

test('CLI candidate finalization cannot write a GitHub Release', () => {
  const jobs = workflow('publish-cli-binaries.yml').jobs;
  const candidate = jobs.finalize_candidate;
  assert.ok(candidate);
  assert.deepEqual(candidate.needs, ['prepare', 'build_native', 'finalize_darwin']);
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

test('CLI candidate code is separated from every standalone signing and publishing secret', () => {
  const jobs = workflow('publish-cli-binaries.yml').jobs;
  const candidateCodeJobs = ['prepare', 'build_native', 'admit_publication'];
  for (const jobName of candidateCodeJobs) {
    const job = jobs[jobName];
    assert.ok(job, `missing candidate-code job ${jobName}`);
    const source = JSON.stringify(job);
    assert.equal(job.environment, undefined, `${jobName} must not enter the signing environment`);
    assert.doesNotMatch(
      source,
      /secrets\.APPLE_|secrets\.MINISIGN_|secrets\.RELEASE_BOT_|create-github-app-token/,
      `${jobName} executes candidate-controlled source and therefore must remain secret-free`,
    );
  }

  assert.doesNotMatch(
    JSON.stringify(jobs.build_native),
    /APPLE_(?:CERTIFICATE|CERTIFICATE_PASSWORD|API_KEY_ID|API_ISSUER_ID|API_PRIVATE_KEY)/,
    'the five-leaf native builder must never cross the Apple signing trust boundary',
  );

  for (const jobName of ['finalize_darwin', 'finalize_candidate', 'publish']) {
    const job = jobs[jobName];
    assert.ok(job, `missing privileged finalizer ${jobName}`);
    const checkouts = (job.steps ?? []).filter((step) => usesAction(step, 'actions/checkout'));
    assert.equal(checkouts.length, 1, `${jobName} must have exactly one trusted control checkout`);
    assert.equal(checkouts[0].with?.ref, '${{ job.workflow_sha }}', `${jobName} checkout authority`);
    assert.equal(checkouts[0].with?.path, undefined, `${jobName} must execute trusted control at the workspace root`);
    assert.doesNotMatch(
      JSON.stringify(job),
      /uses":"\.\/\.release-control|node \.release-control|yarn --cwd \.release-control/,
      `${jobName} must not leave candidate source as the workspace execution owner`,
    );
  }
});

test('CLI Darwin archives are finalized as two exact source/version-bound leaves with required evidence', () => {
  const jobs = workflow('publish-cli-binaries.yml').jobs;
  const darwin = jobs.finalize_darwin;
  assert.ok(darwin);
  assert.deepEqual(darwin.needs, ['prepare', 'build_native', 'attest_native']);
  assert.deepEqual(
    darwin.strategy.matrix.include.map(({ platform_key, runner, cli_target }) => ({
      platform_key,
      runner,
      cli_target,
    })),
    [
      { platform_key: 'darwin-x64', runner: 'macos-15-intel', cli_target: 'darwin-x64' },
      { platform_key: 'darwin-arm64', runner: 'macos-15', cli_target: 'darwin-arm64' },
    ],
  );
  const source = JSON.stringify(darwin);
  assert.match(source, /cli-native-.*matrix\.platform_key.*needs\.prepare\.outputs\.version.*needs\.prepare\.outputs\.source_sha/);
  assert.match(source, /notarize-standalone-binary\.mjs/);
  assert.match(source, /--refresh-cli-runtime-asset-manifest/);
  assert.match(source, /--verify-evidence/);
  assert.match(source, /matrix\.platform_key.*\.cli\.json/);
  assert.match(source, /cli-signed-.*matrix\.platform_key.*needs\.prepare\.outputs\.version.*needs\.prepare\.outputs\.source_sha/);

  for (const jobName of ['finalize_candidate', 'publish']) {
    const jobSource = JSON.stringify(jobs[jobName]);
    assert.match(jobSource, /cli-signed-/, `${jobName} must consume the trusted Darwin leaf handoff`);
    assert.match(jobSource, /darwin-x64\.cli\.json/);
    assert.match(jobSource, /darwin-arm64\.cli\.json/);
  }
});

test('CLI preparation never executes candidate source with the GitHub token', () => {
  const prepare = workflow('publish-cli-binaries.yml').jobs.prepare;
  const sourceCheckout = prepare.steps.find(
    (step) => step.name === 'Checkout exact source as inert data',
  );
  assert.ok(sourceCheckout);
  assert.equal(sourceCheckout.with?.path, '.candidate-source');
  assert.notEqual(sourceCheckout.with?.ref, '${{ job.workflow_sha }}');

  const tokenSteps = prepare.steps.filter((step) => (
    JSON.stringify(step.env ?? {}).includes('${{ github.token }}')
  ));
  assert.ok(tokenSteps.length > 0, 'trusted version/provenance control still needs read authority');
  for (const step of tokenSteps) {
    assert.doesNotMatch(
      JSON.stringify(step),
      /\.candidate-source|uses":"\.\//,
      `GitHub-token step must execute only trusted workflow-SHA control: ${step.name}`,
    );
  }
  const source = JSON.stringify(prepare);
  assert.doesNotMatch(source, /uses":"\.\/\.candidate-source/);
  assert.doesNotMatch(source, /working-directory":"\.candidate-source/);
  assert.doesNotMatch(source, /node \.candidate-source|yarn --cwd \.candidate-source/);
});

test('CLI candidate base versions cross the privileged shell only as canonical data', async () => {
  const jobs = workflow('publish-cli-binaries.yml').jobs;
  const readBaseVersion = jobs.prepare.steps.find(
    (step) => step.name === 'Read candidate base version as data',
  );
  assert.ok(readBaseVersion, 'candidate base-version reader');
  const readRun = String(readBaseVersion.run ?? '');
  assert.match(
    readRun,
    /normalizeRollingBaseVersion/,
    'the workflow must reuse the release allocator\'s canonical base-version validator',
  );
  assert.match(
    readRun,
    /normalizeRollingBaseVersion\(value\)\s*!==\s*value/,
    'candidate package versions must be exact canonical base semver, not merely normalizable',
  );
  assert.doesNotMatch(
    readRun,
    /\.candidate-source\/scripts/,
    'candidate-controlled source must remain inert while its package version is validated',
  );

  const { normalizeRollingBaseVersion } = await import(
    '../pipeline/release/lib/rolling-version-allocation.mjs'
  );
  assert.equal(normalizeRollingBaseVersion('1.2.3'), '1.2.3');
  for (const maliciousVersion of [
    '1.2.3\nmalicious_key=$(touch /tmp/happier-release-pwned)',
    '1.2.3; touch /tmp/happier-release-pwned',
  ]) {
    assert.throws(
      () => normalizeRollingBaseVersion(maliciousVersion),
      /Invalid version/,
      `candidate version must reject shell payload: ${JSON.stringify(maliciousVersion)}`,
    );
  }

  const allocate = jobs.prepare.steps.find(
    (step) => step.name === 'Allocate one release version for the native matrix',
  );
  assert.ok(allocate, 'privileged version allocator');
  assert.equal(
    allocate.env?.CANDIDATE_BASE_VERSION,
    '${{ steps.candidate_base.outputs.base_version }}',
  );
  assert.match(String(allocate.run ?? ''), /--base-version "\$CANDIDATE_BASE_VERSION"/);
  assert.doesNotMatch(
    String(allocate.run ?? ''),
    /\$\{\{\s*steps\.candidate_base\.outputs\.base_version\s*\}\}/,
    'candidate data must never be expression-interpolated into privileged shell source',
  );
  assert.equal(jobs.prepare.outputs?.base_version, '${{ steps.candidate_base.outputs.base_version }}');
  const publishers = workflow('publish-cli-binaries.yml').jobs.publish.steps.filter(
    (step) => String(step.run ?? '').includes('publish-cli-binaries.mjs'),
  );
  assert.equal(publishers.length, 2);
  for (const publisher of publishers) {
    assert.equal(
      publisher.env?.CANDIDATE_BASE_VERSION,
      '${{ needs.prepare.outputs.base_version }}',
    );
    assert.match(String(publisher.run), /--base-version "\$CANDIDATE_BASE_VERSION"/);
  }
});

test('CLI candidate builders have no OIDC or attestation authority', () => {
  const jobs = workflow('publish-cli-binaries.yml').jobs;
  const build = jobs.build_native;
  assert.deepEqual(build.permissions, {});
  assert.doesNotMatch(
    JSON.stringify(build),
    /id-token|attestations|artifact-metadata|actions\/attest/,
  );
  assert.match(JSON.stringify(build), /cli-source-.*needs\.prepare\.outputs\.source_sha/);

  const attest = jobs.attest_native;
  assert.ok(attest, 'trusted artifact-only attestation owner');
  assert.deepEqual(attest.needs, ['prepare', 'build_native']);
  assert.equal(attest.permissions?.['id-token'], 'write');
  assert.equal(attest.permissions?.attestations, 'write');
  assert.equal(attest.permissions?.['artifact-metadata'], 'write');
  const checkouts = attest.steps.filter((step) => usesAction(step, 'actions/checkout'));
  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0].with?.ref, '${{ job.workflow_sha }}');
  assert.match(JSON.stringify(attest), /actions\/download-artifact/);
  assert.match(JSON.stringify(attest), /actions\/attest/);
  assert.doesNotMatch(
    JSON.stringify(attest),
    /Checkout exact source|install-yarn-dependencies|release-build-cli-binaries|managed-runtime:build/,
  );
});
