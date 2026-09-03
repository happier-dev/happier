import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const guardScript = path.join(repoRoot, 'scripts', 'pipeline', 'github', 'enforce-server-runtime-activity-rollout.mjs');
const trustedPromotionScript = path.join(repoRoot, 'scripts', 'pipeline', 'github', 'promote-server-deploy-ref.mjs');
const trustedBumpScript = path.join(repoRoot, 'scripts', 'pipeline', 'github', 'prepare-server-release-bump.mjs');
const trustedInputResolver = path.join(repoRoot, 'scripts', 'pipeline', 'github', 'resolve-server-promotion-inputs.mjs');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Happier Test',
      GIT_AUTHOR_EMAIL: 'test@happier.dev',
      GIT_COMMITTER_NAME: 'Happier Test',
      GIT_COMMITTER_EMAIL: 'test@happier.dev',
    },
  }).trim();
}

function createHistory() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-server-rollout-floor-'));
  git(cwd, ['init', '--quiet']);
  const commits = [];
  for (const value of ['r0-fence', 'r2-drained', 'r3-candidate']) {
    fs.writeFileSync(path.join(cwd, 'state.txt'), `${value}\n`, 'utf8');
    git(cwd, ['add', 'state.txt']);
    git(cwd, ['commit', '--quiet', '-m', value]);
    commits.push(git(cwd, ['rev-parse', 'HEAD']));
  }
  return { cwd, commits };
}

function runGuard(cwd, args) {
  return spawnSync(process.execPath, [guardScript, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function workflowStep(workflow, name, fromIndex = 0) {
  const start = workflow.indexOf(`      - name: ${name}`, fromIndex);
  assert.ok(start >= 0, `missing workflow step: ${name}`);
  const next = workflow.indexOf('\n      - name:', start + 1);
  return workflow.slice(start, next >= 0 ? next : workflow.length);
}

function workflowJob(workflow, jobId) {
  const jobsStart = workflow.indexOf('\njobs:\n');
  const start = workflow.indexOf(`  ${jobId}:\n`, jobsStart);
  assert.ok(start >= 0, `missing workflow job: ${jobId}`);
  const remainder = workflow.slice(start + `  ${jobId}:\n`.length);
  const nextMatch = /^  [a-zA-Z0-9_-]+:\s*$/m.exec(remainder);
  const end = nextMatch ? start + `  ${jobId}:\n`.length + nextMatch.index : workflow.length;
  return workflow.slice(start, end);
}

test('post-activation server promotion requires and enforces both fence and drained-fleet ancestors', () => {
  const { cwd, commits: [fenceSha, drainedSha, candidateSha] } = createHistory();
  try {
    const accepted = runGuard(cwd, [
      '--rollout-stage', 'post_activation',
      '--candidate-sha', candidateSha,
      '--minimum-fence-sha', fenceSha,
      '--r2-drained-sha', drainedSha,
    ]);
    assert.equal(accepted.status, 0, accepted.stderr);

    const beforeFence = runGuard(cwd, [
      '--rollout-stage', 'post_activation',
      '--candidate-sha', fenceSha,
      '--minimum-fence-sha', drainedSha,
      '--r2-drained-sha', drainedSha,
    ]);
    assert.notEqual(beforeFence.status, 0);
    assert.match(beforeFence.stderr, /does not contain the fence-aware minimum/i);

    const drainBeforeFence = runGuard(cwd, [
      '--rollout-stage', 'post_activation',
      '--candidate-sha', candidateSha,
      '--minimum-fence-sha', drainedSha,
      '--r2-drained-sha', fenceSha,
    ]);
    assert.notEqual(drainBeforeFence.status, 0);
    assert.match(drainBeforeFence.stderr, /R2 full-fleet drain attestation.*fence-aware minimum/i);

    const missingDrain = runGuard(cwd, [
      '--rollout-stage', 'post_activation',
      '--candidate-sha', candidateSha,
      '--minimum-fence-sha', fenceSha,
      '--r2-drained-sha', '',
    ]);
    assert.notEqual(missingDrain.status, 0);
    assert.match(missingDrain.stderr, /R2 full-fleet drain attestation/i);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('pre-activation promotions do not invent a rollback floor before the first v2 claim', () => {
  const { cwd, commits: [, , candidateSha] } = createHistory();
  try {
    const result = runGuard(cwd, [
      '--rollout-stage', 'pre_activation',
      '--candidate-sha', candidateSha,
      '--minimum-fence-sha', '',
      '--r2-drained-sha', '',
    ]);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('promote-server captures the trusted rollout guard before checking out candidate source', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'promote-server.yml'), 'utf8');
  const captureIndex = workflow.indexOf('cp scripts/pipeline/github/enforce-server-runtime-activity-rollout.mjs');
  const sourceCheckoutIndex = workflow.indexOf('Checkout exact authorized source');
  const enforcementIndex = workflow.indexOf('Enforce server runtime-activity rollout policy');
  const finalEnforcementIndex = workflow.indexOf('Revalidate exact server promotion SHA in trusted job');
  const promotionIndex = workflow.indexOf('Promote exact validated SHA to server deploy branch');

  assert.ok(captureIndex >= 0, 'missing trusted rollout guard capture');
  assert.ok(sourceCheckoutIndex > captureIndex, 'candidate checkout must happen after trusted guard capture');
  assert.ok(enforcementIndex > sourceCheckoutIndex, 'guard must evaluate the checked-out candidate');
  assert.ok(finalEnforcementIndex > enforcementIndex, 'clean promotion job must independently revalidate the authorized SHA');
  assert.ok(promotionIndex > finalEnforcementIndex, 'deploy branch promotion must happen only after final SHA revalidation');
  for (const target of ['PREVIEW', 'PRODUCTION']) {
    assert.match(workflow, new RegExp(`HAPPIER_${target}_SERVER_RUNTIME_ACTIVITY_ROLLOUT_STAGE`));
    assert.match(workflow, new RegExp(`HAPPIER_${target}_SERVER_FENCE_AWARE_MINIMUM_SHA`));
    assert.match(workflow, new RegExp(`HAPPIER_${target}_SERVER_SESSION_SYNC_R2_DRAINED_SHA`));
  }
  assert.match(workflow, /\$RUNNER_TEMP\/enforce-server-runtime-activity-rollout\.mjs/);
});

test('promote-server performs the write-capable deploy-ref mutation only from a clean trusted job', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'promote-server.yml'), 'utf8');
  assert.doesNotMatch(
    workflow,
    /node scripts\/pipeline\/run\.mjs promote-deploy-branch/,
    'candidate checkout must not choose or execute the deploy-ref mutation helper',
  );
  assert.match(workflow, /Capture trusted server deploy mutation/);
  assert.match(workflow, /\$RUNNER_TEMP\/promote-server-deploy-ref\.mjs/);
  assert.match(workflow, /\$RUNNER_TEMP\/deploy-ref-cas\.mjs/);
  assert.match(workflow, /steps\.bind\.outputs\.candidate_sha/);
  assert.match(workflow, /--expected-current-sha/);
  assert.doesNotMatch(workflow, /persist-credentials:\s+true/);
  assert.doesNotMatch(workflow, /git remote set-url|https:\/\/x-access-token:/, 'deploy-capable credentials must not be persisted in the remote URL');
  assert.match(workflow, /HAPPIER_GIT_AUTHORIZATION_HEADER/);
  assert.doesNotMatch(workflow, /AUTHORIZATION:\s*bearer/, 'Git smart HTTP does not accept GitHub App bearer authentication');
  assert.match(workflow, /AUTHORIZATION: basic \$auth/);

  const promotionStep = workflowStep(workflow, 'Promote exact validated SHA to server deploy branch');
  assert.match(promotionStep, /node "\$RUNNER_TEMP\/promote-server-deploy-ref\.mjs"/);
  assert.doesNotMatch(promotionStep, /scripts\/pipeline\/run\.mjs/);
  assert.doesNotMatch(promotionStep, /git rev-parse HEAD/);
  const webhookStep = workflowStep(workflow, 'Trigger trusted deploy webhook(s) (force_deploy, no branch change)');
  assert.match(webhookStep, /--sha "\$\{\{ steps\.promote_ref\.outputs\.new_sha \}\}"/);
  assert.doesNotMatch(webhookStep, /git rev-parse|needs\.validate_candidate\.outputs/);
});

test('trusted server deploy mutation ignores a candidate-controlled helper and rejects stale ref state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-trusted-server-promote-'));
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const candidate = path.join(root, 'candidate');
  try {
    git(root, ['init', '--quiet', '--bare', remote]);
    fs.mkdirSync(seed);
    git(seed, ['init', '--quiet']);
    fs.writeFileSync(path.join(seed, 'state.txt'), 'base\n');
    git(seed, ['add', 'state.txt']);
    git(seed, ['commit', '--quiet', '-m', 'base']);
    const baseSha = git(seed, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(seed, 'state.txt'), 'intended\n');
    git(seed, ['commit', '--quiet', '-am', 'intended']);
    const intendedSha = git(seed, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(seed, 'state.txt'), 'malicious\n');
    git(seed, ['commit', '--quiet', '-am', 'malicious']);
    const maliciousSha = git(seed, ['rev-parse', 'HEAD']);
    git(seed, ['remote', 'add', 'origin', remote]);
    git(seed, ['push', '--quiet', 'origin', `${baseSha}:refs/heads/deploy/preview/server`]);
    git(seed, ['push', '--quiet', 'origin', `${intendedSha}:refs/heads/candidate`]);
    git(seed, ['push', '--quiet', 'origin', `${maliciousSha}:refs/heads/malicious`]);

    git(root, ['clone', '--quiet', remote, candidate]);
    git(candidate, ['checkout', '--quiet', intendedSha]);
    const candidateHelper = path.join(candidate, 'scripts', 'pipeline', 'github', 'promote-deploy-branch.mjs');
    fs.mkdirSync(path.dirname(candidateHelper), { recursive: true });
    fs.writeFileSync(candidateHelper, [
      "import fs from 'node:fs';",
      `fs.writeFileSync(${JSON.stringify(path.join(root, 'candidate-helper-executed'))}, 'yes');`,
      `process.exitCode = ${maliciousSha === intendedSha ? 0 : 1};`,
    ].join('\n'));

    const promoted = spawnSync(process.execPath, [
      trustedPromotionScript,
      '--deploy-environment', 'preview',
      '--candidate-sha', intendedSha,
      '--expected-current-sha', baseSha,
    ], { cwd: candidate, encoding: 'utf8' });
    assert.equal(promoted.status, 0, promoted.stderr);
    assert.equal(git(seed, ['ls-remote', remote, 'refs/heads/deploy/preview/server']).split(/\s+/)[0], intendedSha);
    assert.equal(fs.existsSync(path.join(root, 'candidate-helper-executed')), false);

    git(seed, ['push', '--quiet', '--force', 'origin', `${maliciousSha}:refs/heads/deploy/preview/server`]);
    const stale = spawnSync(process.execPath, [
      trustedPromotionScript,
      '--deploy-environment', 'preview',
      '--candidate-sha', intendedSha,
      '--expected-current-sha', baseSha,
    ], { cwd: candidate, encoding: 'utf8' });
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /changed concurrently|expected current/i);
    assert.equal(git(seed, ['ls-remote', remote, 'refs/heads/deploy/preview/server']).split(/\s+/)[0], maliciousSha);

    const createMissing = spawnSync(process.execPath, [
      trustedPromotionScript,
      '--deploy-environment', 'production',
      '--candidate-sha', intendedSha,
      '--expected-current-sha', 'missing',
    ], { cwd: candidate, encoding: 'utf8' });
    assert.equal(createMissing.status, 0, createMissing.stderr);
    assert.equal(git(seed, ['ls-remote', remote, 'refs/heads/deploy/production/server']).split(/\s+/)[0], intendedSha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reusable promote-server trust binds called workflow identity, not caller identity', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'promote-server.yml'), 'utf8');
  const callerRepository = 'example/caller';
  const workflowRepository = 'happier-dev/happier';
  const callerSha = '1'.repeat(40);
  const workflowSha = '2'.repeat(40);
  const callerWorkflowRef = `${callerRepository}/.github/workflows/caller.yml@refs/heads/feature`;
  const workflowRef = `${workflowRepository}/.github/workflows/promote-server.yml@refs/heads/main`;
  assert.notEqual(callerSha, workflowSha);
  assert.notEqual(callerWorkflowRef, workflowRef);

  const rendered = workflow
    .replaceAll('${{ job.workflow_repository }}', workflowRepository)
    .replaceAll('${{ job.workflow_sha }}', workflowSha)
    .replaceAll('${{ job.workflow_ref }}', workflowRef)
    .replaceAll('${{ github.repository }}', callerRepository)
    .replaceAll('${{ github.workflow_sha }}', callerSha)
    .replaceAll('${{ github.workflow_ref }}', callerWorkflowRef);
  const actorGuardCheckout = workflowStep(rendered, 'Checkout');
  const rolloutGuardCheckout = workflowStep(rendered, 'Checkout trusted workflow policy');
  const promotionGuardCheckout = workflowStep(rendered, 'Checkout trusted server promotion policy');
  const trustedRefCheck = workflowStep(rendered, 'Enforce trusted workflow control ref');
  const trustedPromotionRefCheck = workflowStep(rendered, 'Enforce trusted server promotion control ref');

  for (const trustCheckout of [actorGuardCheckout, rolloutGuardCheckout, promotionGuardCheckout]) {
    assert.match(trustCheckout, new RegExp(`repository:\\s+${workflowRepository}`));
    assert.match(trustCheckout, new RegExp(`ref:\\s+${workflowSha}`));
    assert.doesNotMatch(trustCheckout, new RegExp(`repository:\\s+${callerRepository}`));
    assert.doesNotMatch(trustCheckout, new RegExp(`ref:\\s+${callerSha}`));
  }
  for (const trustRefCheck of [trustedRefCheck, trustedPromotionRefCheck]) {
    assert.match(trustRefCheck, new RegExp(workflowRef.replaceAll('/', '\\/')));
    assert.doesNotMatch(trustRefCheck, new RegExp(callerWorkflowRef.replaceAll('/', '\\/')));
  }
});

test('candidate validation runs without deploy-capable credentials or writable checkout state', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'promote-server.yml'), 'utf8');
  const candidateJob = workflowJob(workflow, 'validate_candidate');

  assert.doesNotMatch(candidateJob, /create-github-app-token|RELEASE_BOT_|GH_TOKEN|MINISIGN_SECRET|private[-_]key/i);
  assert.doesNotMatch(candidateJob, /github-commit-and-push|publish-server-runtime|git\s+push/i);
  assert.doesNotMatch(candidateJob, /persist-credentials:\s*true/i);
  assert.match(candidateJob, /persist-credentials:\s*false/i);
  assert.match(candidateJob, /ref:\s*\$\{\{\s*needs\.resolve_source\.outputs\.candidate_sha\s*\}\}/);
});

test('trusted bump and final source binding run in fresh jobs outside candidate execution', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'promote-server.yml'), 'utf8');
  const bumpJob = workflowJob(workflow, 'apply_bump');
  const finalizeJob = workflowJob(workflow, 'finalize_source');

  assert.match(bumpJob, /prepare-server-release-bump\.mjs/);
  assert.match(bumpJob, /--force-with-lease|prepare-server-release-bump/);
  assert.doesNotMatch(bumpJob, /install-yarn-dependencies|yarn\s|scripts\/pipeline\/run\.mjs/);
  assert.doesNotMatch(bumpJob, /persist-credentials:\s*true/);
  assert.match(finalizeJob, /needs:\s*\[[^\]]*resolve_source[^\]]*apply_bump[^\]]*validate_candidate[^\]]*\]/);
  assert.match(finalizeJob, /git diff --name-only/);
  assert.match(finalizeJob, /authorized_sha=/);
  assert.doesNotMatch(finalizeJob, /needs\.validate_candidate\.outputs/);
});

test('candidate validates the would-be bump before any trusted source mutation job can run', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'promote-server.yml'), 'utf8');
  const candidateJob = workflowJob(workflow, 'validate_candidate');
  const bumpJob = workflowJob(workflow, 'apply_bump');
  const localBump = candidateJob.indexOf('Apply trusted bump transform locally');
  const firstCandidateCommand = candidateJob.indexOf('Install dependencies');

  assert.match(candidateJob, /needs:\s*\[release_actor_guard, resolve_source\]/);
  assert.ok(localBump >= 0 && firstCandidateCommand > localBump);
  assert.match(candidateJob, /--push\s+false/);
  assert.match(bumpJob, /needs:\s*\[[^\]]*validate_candidate[^\]]*\]/);
  assert.match(bumpJob, /--push\s+true/);
});

test('optional runtime publishing runs after final source binding and gates deploy promotion', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'promote-server.yml'), 'utf8');
  const runtimeJob = workflowJob(workflow, 'publish_runtime_release');
  const promotionJob = workflowJob(workflow, 'promote_deploy_ref');

  assert.match(runtimeJob, /uses:\s*\.\/\.github\/workflows\/publish-server-runtime\.yml/);
  assert.match(runtimeJob, /needs:\s*\[[^\]]*finalize_source[^\]]*\]/);
  assert.match(runtimeJob, /source_ref:\s*\$\{\{ needs\.finalize_source\.outputs\.authorized_sha \}\}/);
  assert.doesNotMatch(runtimeJob, /needs\.resolve_source\.outputs\.source_ref|candidate_sha|artifact/);
  assert.match(promotionJob, /needs:\s*\[[^\]]*publish_runtime_release[^\]]*\]/);
  assert.match(promotionJob, /needs\.publish_runtime_release\.result == 'success'.*needs\.publish_runtime_release\.result == 'skipped'/);
});

test('workflow inputs never interpolate directly into shell run bodies', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'promote-server.yml'), 'utf8');
  const parsed = parseYaml(workflow);
  const runBodies = Object.values(parsed.jobs ?? {}).flatMap((job) =>
    Array.isArray(job?.steps) ? job.steps.map((step) => step?.run).filter((run) => typeof run === 'string') : [],
  );
  assert.ok(runBodies.length > 0);
  for (const runBody of runBodies) {
    assert.doesNotMatch(runBody, /\$\{\{\s*inputs\./);
  }
});

test('every promotion and runtime publisher checkout explicitly disables credential persistence', () => {
  for (const workflowName of ['promote-server.yml', 'publish-server-runtime.yml']) {
    const workflow = parseYaml(fs.readFileSync(path.join(repoRoot, '.github', 'workflows', workflowName), 'utf8'));
    for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
      if (!Array.isArray(job?.steps)) continue;
      for (const step of job.steps) {
        if (step?.uses !== 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262') continue;
        assert.equal(
          step?.with?.['persist-credentials'],
          false,
          `${workflowName} ${jobId}/${step.name ?? 'checkout'} must explicitly disable credential persistence`,
        );
      }
    }
  }
});

test('trusted promotion input resolver rejects shell and GitHub-output injection payloads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-promotion-inputs-'));
  try {
    for (const payload of ['preview"; touch /tmp/pwned; #', '$(touch /tmp/pwned)', 'preview\nforged_sha=abc', '::set-output name=x::y']) {
      const output = path.join(root, `output-${Buffer.from(payload).toString('hex')}`);
      const result = spawnSync(process.execPath, [
        trustedInputResolver,
        '--environment', 'preview',
        '--source-ref', payload,
        '--allow-cross-promote', 'false',
        '--bump', 'none',
        '--github-output', output,
      ], { encoding: 'utf8' });
      assert.notEqual(result.status, 0, `payload should fail closed: ${JSON.stringify(payload)}`);
      assert.equal(fs.existsSync(output), false);
    }
    for (const [option, payload] of [
      ['--environment', 'preview\nforged=1'],
      ['--allow-cross-promote', 'false; touch /tmp/pwned'],
      ['--bump', 'patch$(touch /tmp/pwned)'],
    ]) {
      const output = path.join(root, `option-${option.slice(2)}`);
      const args = [
        '--environment', 'preview', '--source-ref', 'preview', '--allow-cross-promote', 'false', '--bump', 'none', '--github-output', output,
      ];
      args[args.indexOf(option) + 1] = payload;
      const result = spawnSync(process.execPath, [trustedInputResolver, ...args], { encoding: 'utf8' });
      assert.notEqual(result.status, 0, `${option} payload should fail closed`);
      assert.equal(fs.existsSync(output), false);
    }

    const output = path.join(root, 'valid-output');
    const valid = spawnSync(process.execPath, [
      trustedInputResolver,
      '--environment', 'preview',
      '--source-ref', 'auto',
      '--allow-cross-promote', 'false',
      '--bump', 'patch',
      '--github-output', output,
    ], { encoding: 'utf8' });
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(fs.readFileSync(output, 'utf8'), 'source_ref=preview\nenvironment=preview\nbump=patch\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('trusted promotion independently resolves the authorized source and ignores candidate temp/output selection', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'promote-server.yml'), 'utf8');
  const promotionJob = workflowJob(workflow, 'promote_deploy_ref');

  assert.match(promotionJob, /needs:\s*\[[^\]]*resolve_source[^\]]*validate_candidate[^\]]*\]/);
  assert.doesNotMatch(promotionJob, /needs\.validate_candidate\.outputs\.(?:release_sha|candidate_sha)/);
  assert.doesNotMatch(promotionJob, /needs\.promote\.outputs\.release_sha/);
  assert.match(promotionJob, /Resolve exact authorized server release SHA/);
  assert.match(promotionJob, /ref:\s*\$\{\{\s*steps\.trusted_resolve\.outputs\.source_ref\s*\}\}/);
  assert.match(promotionJob, /test "\$\{candidate_sha\}" = "\$\{\{ needs\.finalize_source\.outputs\.authorized_sha \}\}"/);

  const trustedCapture = promotionJob.indexOf('Capture trusted server deploy mutation');
  const candidateCheckout = promotionJob.indexOf('Checkout exact authorized server release SHA');
  assert.ok(trustedCapture >= 0 && candidateCheckout > trustedCapture);
});

test('trusted server bump changes only synchronized package versions and CAS-pushes the allowed source branch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-trusted-server-bump-'));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  try {
    git(root, ['init', '--quiet', '--bare', remote]);
    fs.mkdirSync(work);
    git(work, ['init', '--quiet']);
    fs.mkdirSync(path.join(work, 'apps', 'server'), { recursive: true });
    fs.mkdirSync(path.join(work, 'packages', 'relay-server'), { recursive: true });
    fs.writeFileSync(path.join(work, 'apps', 'server', 'package.json'), '{"name":"server","version":"1.2.3"}\n');
    fs.writeFileSync(path.join(work, 'packages', 'relay-server', 'package.json'), '{"name":"runner","version":"1.2.3"}\n');
    git(work, ['add', '.']);
    git(work, ['commit', '--quiet', '-m', 'base']);
    const baseSha = git(work, ['rev-parse', 'HEAD']);
    git(work, ['remote', 'add', 'origin', remote]);
    git(work, ['push', '--quiet', 'origin', 'HEAD:refs/heads/preview']);

    const bumped = spawnSync(process.execPath, [
      trustedBumpScript,
      '--bump', 'patch',
      '--source-branch', 'preview',
      '--expected-sha', baseSha,
    ], { cwd: work, encoding: 'utf8' });
    assert.equal(bumped.status, 0, bumped.stderr);
    const bumpedSha = git(work, ['rev-parse', 'HEAD']);
    assert.notEqual(bumpedSha, baseSha);
    assert.equal(git(work, ['rev-parse', `${bumpedSha}^`]), baseSha);
    assert.deepEqual(git(work, ['diff', '--name-only', baseSha, bumpedSha]).split('\n'), [
      'apps/server/package.json',
      'packages/relay-server/package.json',
    ]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(work, 'apps', 'server', 'package.json'), 'utf8')).version, '1.2.4');
    assert.equal(git(work, ['ls-remote', remote, 'refs/heads/preview']).split(/\s+/)[0], bumpedSha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
