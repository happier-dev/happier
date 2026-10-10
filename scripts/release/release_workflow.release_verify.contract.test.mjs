import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('release resume rechecks risk-selected suites after the target branch has advanced', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-channel.yml'), 'utf8');
  const verification = YAML.parse(raw).jobs.verify_release_candidates.with;
  for (const risk of ['cli_upgrade', 'session_continuity', 'relay_upgrade']) {
    assert.match(String(verification[`risk_${risk}`]), /needs\.plan\.outputs\.risk_/);
    assert.match(String(verification[`risk_${risk}`]), /inputs\.resume_run_id != ''/);
  }
});

test('release workflow verifies immutable candidates before promoting preview or production channels', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-channel.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  const candidateVerify = workflow.jobs.verify_release_candidates;
  const releaseVerify = workflow.jobs.release_verify;

  assert.equal(workflow.jobs.publish_cli_binaries.with.publish_rolling, false);
  assert.equal(workflow.jobs.publish_hstack_binaries.with.publish_rolling, false);
  assert.equal(workflow.jobs.publish_runner_binaries.with.publish_rolling, false);
  assert.equal(workflow.jobs.publish_server_runtime.with.publish_rolling, false);
  assert.equal(workflow.jobs.publish_ui_web.with.publish_rolling, false);
  assert.equal(candidateVerify.uses, './.github/workflows/release-verify.yml');
  assert.deepEqual(candidateVerify.needs, [
    'resolve_resume',
    'plan',
    'release_admission',
    'prepare_release_candidate',
    'publish_cli_binaries',
    'publish_hstack_binaries',
    'publish_runner_binaries',
    'publish_server_runtime',
    'publish_ui_web',
  ]);
  assert.equal(candidateVerify.with.candidate_source_sha, '${{ needs.prepare_release_candidate.outputs.source_sha }}');
  assert.equal(candidateVerify.with.candidate_cli_version, '${{ needs.publish_cli_binaries.outputs.version }}');
  assert.equal(candidateVerify.with.candidate_stack_version, '${{ needs.publish_hstack_binaries.outputs.version }}');
  assert.equal(candidateVerify.with.candidate_runner_version, '${{ needs.publish_runner_binaries.outputs.version }}');
  assert.equal(candidateVerify.with.candidate_server_version, '${{ needs.publish_server_runtime.outputs.version }}');
  assert.equal(candidateVerify.with.candidate_ui_web_version, '${{ needs.publish_ui_web.outputs.version }}');
  assert.ok(workflow.jobs.promote_server_runtime.needs.includes('verify_release_candidates'));
  assert.ok(workflow.jobs.promote_ui_web.needs.includes('promote_server_runtime'));
  assert.ok(workflow.jobs.promote_cli_binaries.needs.includes('promote_ui_web'));
  assert.ok(workflow.jobs.promote_runner_binaries.needs.includes('verify_release_candidates'));
  assert.equal(workflow.jobs.promote_runner_binaries.needs.includes('promote_hstack_binaries'), false);

  assert.equal(releaseVerify.uses, './.github/workflows/release-verify.yml');
  assert.ok(releaseVerify.needs.includes('publish_runner_binaries'));
  assert.ok(releaseVerify.needs.includes('promote_runner_binaries'));
  assert.ok(releaseVerify.needs.includes('resolve_resume'), 'rolling completion facts require direct resume dependency');
  for (const product of ['cli', 'stack', 'runner', 'server', 'ui_web']) {
    assert.equal(releaseVerify.with['candidate_' + product + '_version'], undefined, 'final verification must select rolling ' + product + ' refs');
  }
  assert.equal(releaseVerify.with.verify_runner_release, "${{ needs.plan.outputs.publish_runner_binaries_needed == 'true' }}");
  assert.match(
    releaseVerify.if,
    /needs\.promote_runner_binaries\.result == 'success' \|\| \(needs\.promote_runner_binaries\.result == 'skipped' && \(needs\.plan\.outputs\.publish_runner_binaries_needed != 'true' \|\| needs\.resolve_resume\.outputs\.runner_rolling_complete == 'true'\)\)/,
  );
  assert.doesNotMatch(releaseVerify.if, /inputs\.checks_profile/);
  assert.match(
    releaseVerify.if,
    /needs\.promote_cli_binaries\.result == 'success' \|\| \(needs\.promote_cli_binaries\.result == 'skipped' && \(needs\.plan\.outputs\.publish_cli_binaries_needed != 'true' \|\| needs\.resolve_resume\.outputs\.cli_rolling_complete == 'true'\)\)/,
  );
  assert.match(
    raw,
    /release_verify:[\s\S]*?channel:\s*\$\{\{\s*inputs\.environment == 'production' && 'production' \|\| 'preview'\s*\}\}/,
    'release.yml should map production releases to production verification and preview releases to preview verification',
  );
  assert.match(
    raw,
    /plan:[\s\S]*?needs:\s*\[release_actor_guard, resolve_resume, resolve_validation_profile, release_preflight\][\s\S]*?needs\.resolve_resume\.result == 'success'[\s\S]*?needs\.resolve_validation_profile\.result == 'success'[\s\S]*?needs\.release_preflight\.result == 'success'/,
    'release.yml should compute channel publication decisions after request validation and resume resolution',
  );
  assert.match(
    raw,
    /sync_dev:[\s\S]*?needs\.release_verify\.result == 'success'[\s\S]*?needs:\s*\[plan, release_admission, promote_main, prepare_release_candidate, release_verify\]/,
    'release.yml should gate the final production sync on release verification succeeding',
  );
  assert.doesNotMatch(
    workflow.jobs.sync_dev.if,
    /needs\.release_verify\.result == 'skipped'/,
    'production sync must not treat skipped post-publication verification as successful admission',
  );
});

test('issue-stage bookkeeping is best effort and never gates product publication', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-channel.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  const snapshot = workflow.jobs.snapshot_release_issues;
  const advance = workflow.jobs.advance_release_issues;

  assert.deepEqual(snapshot.needs, ['release_actor_guard', 'release_preflight']);
  const snapshotStep = snapshot.steps.find((step) => step.id === 'snapshot');
  assert.equal(snapshotStep.env.CANDIDATE_SHA, '${{ inputs.authorized_promotion_source_sha }}');
  const dispatchAdmission = workflow.jobs.release_preflight.steps.find((step) => step.id === 'dispatch');
  assert.equal(dispatchAdmission.env.AUTHORIZED_PROMOTION_SOURCE_SHA, snapshotStep.env.CANDIDATE_SHA);
  assert.match(dispatchAdmission.run, /validate-release-dispatch\.mjs/);
  for (const line of snapshotStep.run.split('\n').filter((line) => line.includes('reconcile-issue-stage.mjs snapshot'))) {
    assert.match(line, /--candidate-sha "\$CANDIDATE_SHA"/);
  }
  assert.equal(snapshot.permissions.issues, 'read');
  assert.match(JSON.stringify(snapshot.steps), /reconcile-issue-stage\.mjs snapshot/);
  assert.match(JSON.stringify(snapshot.steps), /stage:source/);
  assert.match(JSON.stringify(snapshot.steps), /stage:dev/);
  assert.match(JSON.stringify(snapshot.steps), /stage:preview/);
  assert.match(JSON.stringify(snapshot.steps), /INCLUDE_DEVELOPMENT_STAGES/);
  assert.match(JSON.stringify(snapshot.steps), /inputs\.environment == 'preview'/);
  assert.match(JSON.stringify(snapshot.steps), /release dev to main/);
  assert.match(JSON.stringify(snapshot.steps), /reset main from dev/);
  assert.match(JSON.stringify(snapshot.steps), /release preview to main/);
  assert.match(JSON.stringify(snapshot.steps), /reset main from preview/);
  const snapshotRun = String(snapshot.steps.find((step) => step.id === 'snapshot')?.run ?? '');
  assert.match(
    snapshotRun,
    /source_issues_json="\[\]"[\s\S]*?dev_issues_json="\[\]"[\s\S]*?if \[ "\$INCLUDE_DEVELOPMENT_STAGES" = "true" \]; then[\s\S]*?stage:source[\s\S]*?stage:dev[\s\S]*?fi/,
    'source/dev queues must only be captured when the selected candidate comes from dev',
  );
  assert.ok(!workflow.jobs.plan.needs.includes('snapshot_release_issues'));
  assert.equal(snapshot['continue-on-error'], true);
  assert.match(snapshot.if, /inputs\.combined_preview_production != true/);

  assert.deepEqual(advance.needs, ['snapshot_release_issues', 'release_verify', 'release_status']);
  assert.match(String(advance.if), /always\(\)/);
  assert.match(String(advance.if), /needs\.release_status\.result == 'success'/);
  assert.ok(!workflow.jobs.release_status.needs.includes('advance_release_issues'));
  assert.equal(workflow.on.workflow_call.outputs.release_complete.value, '${{ jobs.release_status.outputs.release_complete }}');
  assert.equal(workflow.jobs.release_status.outputs.release_complete, '${{ steps.admit.outputs.release_complete }}');
  const terminalAdmission = workflow.jobs.release_status.steps.find((step) => step.id === 'admit');
  assert.match(String(terminalAdmission?.run), /status\.terminal !== "complete" && status\.terminal !== "published"/);
  assert.match(String(terminalAdmission?.run), /release_complete=true/);
  assert.equal(advance.permissions.issues, 'write');
  assert.match(String(advance.if), /needs\.release_verify\.result == 'success'/);
  assert.equal(advance['continue-on-error'], true);
  assert.match(advance.if, /inputs\.combined_preview_production != true/);
  assert.match(JSON.stringify(advance.steps), /reconcile-issue-stage\.mjs advance/);
  assert.match(JSON.stringify(advance.steps), /stage:source/);
  assert.match(JSON.stringify(advance.steps), /stage:dev/);
  assert.match(JSON.stringify(advance.steps), /stage:preview/);
  assert.match(JSON.stringify(advance.steps), /release preview to main/);
  assert.match(JSON.stringify(advance.steps), /inputs\.environment == 'production' && 'stage:stable' \|\| 'stage:preview'/);
  const root = YAML.parse(await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8'));
  for (const name of ['release_preview', 'release_production']) {
    assert.ok(root.jobs.advance_release_issues.if.includes('needs.' + name + ".outputs.release_complete == 'true'"));
  }
});

test('post-promotion verification receives the selected server runtime probe URL', async () => {
  const workflow = YAML.parse(await readFile(join(repoRoot, '.github', 'workflows', 'release-channel.yml'), 'utf8'));
  assert.equal(
    workflow.jobs.release_verify.with.server_api_version_url,
    "${{ inputs.environment == 'production' && vars.HAPPIER_SERVER_API_PRODUCTION_VERSION_URL || vars.HAPPIER_SERVER_API_PREVIEW_VERSION_URL }}",
  );
});

test('release validation delegates one risk-selected pre-publication platform gate while post-publication verification stays profile-bounded', async () => {
  const [raw, sourceValidationRaw, testsRaw] = await Promise.all([
    readFile(join(repoRoot, '.github', 'workflows', 'release-channel.yml'), 'utf8'),
    readFile(join(repoRoot, '.github', 'workflows', 'release-source-validation.yml'), 'utf8'),
    readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8'),
  ]);
  const workflow = YAML.parse(raw);
  const sourceValidation = YAML.parse(sourceValidationRaw);
  const testsWorkflow = YAML.parse(testsRaw);
  const prePublicationGate = sourceValidation.jobs.platform.with.run_self_host_systemd;
  const root = YAML.parse(await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8'));

  assert.equal(root.jobs.source_validation.uses, './.github/workflows/release-source-validation.yml');
  assert.equal(sourceValidation.jobs.platform.uses, './.github/workflows/tests.yml');
  assert.match(sourceValidation.jobs.platform.if, /needs\.source_plan\.outputs\.run_platform == 'true'/);

  for (const inputName of [
    'run_self_host_systemd',
    'run_self_host_launchd',
    'run_self_host_schtasks',
    'run_self_host_daemon',
  ]) {
    assert.equal(workflow.jobs.release_preflight.with, undefined, 'release preflight must not dispatch another general CI matrix');
    assert.equal(
      sourceValidation.jobs.platform.with[inputName],
      prePublicationGate,
      `release pre-publication platform gates should share one applicability decision`,
    );
    assert.equal(workflow.jobs.release_verify.with[inputName], undefined);
  }

  assert.equal(workflow.jobs.release_verify.with.validation_profile, 'integrated');

  assert.equal(prePublicationGate, true);

  for (const [inputName, jobName, expectedRunner, expectedCommand] of [
    ['run_self_host_systemd', 'self-host-systemd-e2e', 'ubuntu-latest', 'self_host_systemd.real.integration.test.mjs'],
    ['run_self_host_launchd', 'self-host-launchd-e2e', 'macos-latest', 'self_host_launchd.real.integration.test.mjs'],
    ['run_self_host_schtasks', 'self-host-schtasks-e2e', 'windows-latest', 'self_host_schtasks.real.integration.test.mjs'],
  ]) {
    const job = testsWorkflow.jobs[jobName];
    assert.match(job.if, new RegExp(`inputs\\.${inputName}`), `${jobName} should be selected by the forwarded input`);
    assert.equal(job['runs-on'], expectedRunner, `${jobName} should run on its real platform`);
    assert.match(
      job.steps.map((step) => step.run ?? '').join('\n'),
      new RegExp(expectedCommand.replaceAll('.', '\\.')),
      `${jobName} should execute the existing real integration test`,
    );
  }

  const daemonJob = testsWorkflow.jobs['self-host-daemon-e2e'];
  assert.match(daemonJob.if, /inputs\.run_self_host_daemon/);
  assert.deepEqual(daemonJob.strategy.matrix.os, ['ubuntu-latest', 'macos-latest']);
  assert.match(
    daemonJob.steps.map((step) => step.run ?? '').join('\n'),
    /self_host_daemon\.real\.integration\.test\.mjs/,
    'self-host daemon validation should execute the existing real integration test',
  );
});

test('database-affecting server releases invoke the shared MySQL 8 source contract before release mutation', async () => {
  const [releaseRaw, sourceValidationRaw, extendedDbRaw] = await Promise.all([
    readFile(join(repoRoot, '.github', 'workflows', 'release-channel.yml'), 'utf8'),
    readFile(join(repoRoot, '.github', 'workflows', 'release-source-validation.yml'), 'utf8'),
    readFile(join(repoRoot, '.github', 'workflows', 'extended-db-tests.yml'), 'utf8'),
  ]);
  const release = YAML.parse(releaseRaw);
  const sourceValidation = YAML.parse(sourceValidationRaw);
  const extendedDb = YAML.parse(extendedDbRaw);
  const mysqlGate = sourceValidation.jobs.mysql;

  assert.equal(
    mysqlGate.uses,
    './.github/workflows/extended-db-tests.yml',
    'release should reuse the existing extended database workflow',
  );
  assert.match(mysqlGate.if, /needs\.source_plan\.outputs\.run_mysql == 'true'/);
  assert.match(mysqlGate.if, /inputs\.dry_run != true/);
  assert.deepEqual(
    mysqlGate.with,
    {
      checkout_sha: '${{ needs.source_plan.outputs.source_sha }}',
      run_e2e_postgres: false,
      run_e2e_mysql: false,
      run_db_contract_postgres: false,
      run_db_contract_mysql: true,
    },
    'the release invocation should run the material MySQL contract rather than the unrelated extended matrix',
  );

  assert.ok(
    mysqlGate.needs.includes('source_plan'),
    'MySQL validation should run after canonical source-gate planning',
  );
  for (const mutationJobName of ['promote_preview', 'promote_main']) {
    const mutationJob = release.jobs[mutationJobName];
    assert.ok(mutationJob.needs.includes('release_admission'));
    assert.match(
      mutationJob.if,
      /needs\.release_admission\.result == 'success'/,
      `${mutationJobName} should stop when canonical admission rejects the applicable gates`,
    );
  }
  const root = YAML.parse(await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8'));
  assert.equal(release.jobs.source_validation, undefined, 'channel execution consumes source validation rather than dispatching it again');
  assert.ok(release.jobs.release_admission.needs.includes('plan'));
  assert.ok(release.jobs.plan.needs.includes('release_preflight'));
  assert.equal(release.jobs.release_admission.steps.at(-1).env.MYSQL_GATE_RESULT, '${{ inputs.shared_mysql_result }}');
  for (const name of ['release_single', 'release_preview', 'release_production']) {
    assert.ok(root.jobs[name].needs.includes('source_validation'));
    assert.match(root.jobs[name].if, /needs\.source_validation\.result == 'success'/);
    assert.equal(root.jobs[name].with.shared_mysql_result, '${{ needs.source_validation.outputs.mysql_result }}');
  }

  for (const [inputName, jobName] of [
    ['run_e2e_postgres', 'e2e-postgres'],
    ['run_e2e_mysql', 'e2e-mysql'],
    ['run_db_contract_postgres', 'db-contract-postgres'],
    ['run_db_contract_mysql', 'db-contract-mysql'],
  ]) {
    assert.equal(
      extendedDb.on.workflow_call.inputs[inputName].default,
      true,
      `the reusable extended database workflow should preserve its default ${jobName} matrix coverage`,
    );
    assert.match(
      extendedDb.jobs[jobName].if,
      new RegExp(`github\\.event_name != 'workflow_call' \\|\\| inputs\\.${inputName}`),
      `${jobName} should remain active for schedule/manual runs and selectable for reusable calls`,
    );
  }
  assert.equal(
    extendedDb.jobs['db-contract-mysql'].services.mysql.image,
    'mysql:8.0',
    'the release gate should remain backed by a real MySQL 8 service',
  );
  assert.match(
    extendedDb.jobs['db-contract-mysql'].steps
      .map((step) => step.run ?? '')
      .join('\n'),
    /test:mysql-voice-identity-upgrade-contract/,
    'the release gate should execute the existing Voice rolling-upgrade contract',
  );
});

test('detected and forced server or CLI publication cannot bypass canonical release gates', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-channel.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  const planOutputs = workflow.jobs.plan.outputs;

  assert.match(planOutputs.publish_server_runtime_needed, /inputs\.force_deploy == true/);
  assert.match(planOutputs.publish_server_runtime_needed, /steps\.plan\.outputs\.changed_ui == 'true'/);
  assert.match(planOutputs.publish_server_runtime_needed, /steps\.plan\.outputs\.changed_server == 'true'/);
  assert.match(planOutputs.publish_server_runtime_needed, /steps\.plan\.outputs\.changed_shared == 'true'/);
  assert.match(planOutputs.publish_server_runtime_needed, /steps\.bump_plan\.outputs\.publish_server == 'true'/);

  assert.match(planOutputs.publish_cli_binaries_needed, /inputs\.force_deploy == true/);
  assert.match(planOutputs.publish_cli_binaries_needed, /steps\.plan\.outputs\.changed_cli == 'true'/);
  assert.match(planOutputs.publish_cli_binaries_needed, /steps\.plan\.outputs\.changed_cli_stack_shared == 'true'/);
  assert.match(planOutputs.publish_cli_binaries_needed, /steps\.plan\.outputs\.changed_shared == 'true'/);
  assert.match(planOutputs.publish_cli_binaries_needed, /steps\.bump_plan\.outputs\.publish_cli == 'true'/);

  assert.match(
    workflow.jobs.publish_server_runtime.if,
    /needs\.plan\.outputs\.publish_server_runtime_needed == 'true'/,
    'server publisher should consume the canonical server publication decision',
  );
  assert.match(
    workflow.jobs.publish_cli_binaries.if,
    /needs\.plan\.outputs\.publish_cli_binaries_needed == 'true'/,
    'CLI publisher should consume the canonical CLI publication decision',
  );

  assert.equal(workflow.jobs.mysql_db_contract, undefined);
  assert.equal(workflow.jobs.platform_service_validation, undefined);
  assert.equal(workflow.jobs.trust_root_validation, undefined);
  assert.match(
    JSON.stringify(YAML.parse(await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8')).jobs.source_validation),
    /release-source-validation\.yml/,
    'source-gate applicability must have one reusable workflow owner',
  );
});

test('publication admission requires full stable checks and risk-selected server evidence', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-channel.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  const admission = workflow.jobs.release_admission;
  const admissionScript = admission.steps.map((step) => step.run ?? '').join('\n');

  assert.ok(admission, 'release.yml should have one canonical release admission job');
  assert.ok(admission.needs.includes('plan'));
  assert.ok(workflow.jobs.plan.needs.includes('release_preflight'));
  const root = YAML.parse(await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8'));
  assert.equal(root.on.workflow_dispatch.inputs.approve_public_sdk_release.type, 'boolean');
  assert.equal(root.on.workflow_dispatch.inputs.public_sdk_release_approval.type, 'string');
  assert.equal(root.on.workflow_dispatch.inputs.public_sdk_release_approval.default, '{}');
  assert.equal(admission.steps.at(-1).env.CI_GATE_RESULT, '${{ inputs.shared_ci_result }}');
  assert.equal(admission.steps.at(-1).env.VALIDATED_SOURCE_SHA, '${{ inputs.shared_source_validation_sha }}');
  assert.equal(
    workflow.jobs.publish_npm.with.approve_public_sdk_release,
    '${{ inputs.approve_public_sdk_release }}',
    'the exact packed public SDK candidate must consume the reviewed maintainer decision',
  );
  assert.equal(workflow.jobs.release_admission.steps.at(-1).env.SDK_API_CLASSIFICATION,
    '${{ needs.release_preflight.outputs.sdk_api_classification }}');
  assert.match(
    workflow.jobs.release_admission.steps.map((step) => step.run ?? '').join('\n'),
    /scripts\/pipeline\/release\/admit-release\.mjs/u,
  );
  assert.equal(workflow.jobs.release_admission.steps.at(-1).env.SDK_API_HUMAN_REVIEW_REQUIRED,
    '${{ needs.plan.outputs.sdk_api_human_review_required }}');
  assert.equal(
    workflow.jobs.release_admission.steps.at(-1).env.PUBLISH_STACK,
    "${{ needs.plan.outputs.publish_stack == 'true' }}",
    'channel admission must consume the canonical stack publication decision',
  );
  assert.match(
    admissionScript,
    /scripts\/pipeline\/release\/admit-release\.mjs/,
    'release mutation admission must delegate stable and risk-selected policy to the source owner',
  );
  assert.doesNotMatch(admissionScript, /RISK_TRUST_ROOTS.*TRUST_ROOT_GATE_RESULT.*success/s);

  const sourceValidation = YAML.parse(await readFile(join(repoRoot, '.github', 'workflows', 'release-source-validation.yml'), 'utf8'));
  const trustGate = sourceValidation.jobs.trust_roots;
  assert.match(trustGate.if, /needs\.source_plan\.outputs\.run_trust_roots == 'true'/);
  assert.equal(trustGate.steps[0].with.ref, '${{ needs.source_plan.outputs.source_sha }}');
  assert.match(
    trustGate.steps.map((step) => step.run ?? '').join('\n'),
    /installers_security\.test\.mjs[\s\S]*tauri-validate-updater-pubkey/,
  );
  assert.doesNotMatch(admissionScript, /server runtime publication requires checks_profile=full/);
  assert.doesNotMatch(
    admissionScript,
    /MYSQL_GATE_RESULT.*success|PLATFORM_GATE_RESULT.*success/s,
    'workflow YAML must pass gate facts to the source-owned admission policy without reimplementing it',
  );

  for (const jobName of [
    'promote_preview',
    'promote_main',
    'deploy_ui',
    'deploy_server',
    'publish_server_runtime',
    'publish_ui_web',
    'publish_cli_binaries',
    'publish_docker',
    'deploy_website',
    'deploy_docs',
    'publish_npm',
    'sync_dev',
  ]) {
    const job = workflow.jobs[jobName];
    assert.ok(job.needs.includes('release_admission'), `${jobName} must consume full release admission`);
    assert.match(
      job.if,
      /needs\.release_admission\.result == 'success'/,
      `${jobName} must fail closed when release admission does not pass`,
    );
  }
});

test('release admission requires the external signed Mutagen engine release gate', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-channel.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  const gateJobName = 'mutagen_engine_release_gate';
  const gateJobNames = Object.entries(workflow.jobs)
    .filter(([, job]) => (job.steps ?? []).some(
      (step) => step.env?.HAPPIER_TEST_MUTAGEN_ENGINE_LIVE_ACQUISITION === '1',
    ))
    .map(([name]) => name);
  assert.deepEqual(
    gateJobNames,
    [gateJobName],
    'release.yml must keep exactly one Mutagen managed-component preflight gate',
  );

  const gate = workflow.jobs[gateJobName];
  assert.deepEqual(gate.needs, ['plan'], 'the Mutagen gate must run after the release plan');
  assert.equal(gate.permissions?.contents, 'read');
  assert.equal(
    gate.if,
    undefined,
    'the external release prerequisite is unconditional; no dry-run or publication-target waiver exists',
  );
  const checkouts = gate.steps.filter((step) => String(step.uses ?? '').startsWith('actions/checkout'));
  assert.equal(checkouts.length, 1);
  assert.equal(
    checkouts[0].with.ref,
    '${{ needs.plan.outputs.source_sha }}',
    'the gate must acquire the exact source verified by the release plan, including dry runs',
  );
  assert.equal(checkouts[0].with.repository, '${{ github.repository }}');
  assert.equal(checkouts[0].with['persist-credentials'], false);

  const install = gate.steps.find((step) => String(step.uses ?? '').startsWith('./.github/actions/install-yarn-dependencies'));
  assert.ok(install, 'the gate must install workspace dependencies through the existing shared action');
  const liveRuns = gate.steps.filter((step) => step.env?.HAPPIER_TEST_MUTAGEN_ENGINE_LIVE_ACQUISITION === '1');
  assert.equal(liveRuns.length, 1, 'the gate must run only the existing live acquisition test without duplicating its assertions');
  assert.match(
    liveRuns[0].run,
    /yarn workspace @happier-dev\/cli-common test:mutagen-engine:live:local/u,
  );
  assert.equal(liveRuns[0].env?.HAPPIER_TEST_MUTAGEN_ENGINE_LIVE_ACQUISITION, '1');
  assert.equal(liveRuns[0].env?.GITHUB_TOKEN, '${{ github.token }}', 'the live acquisition needs a token suitable for public release API access');

  const admission = workflow.jobs.release_admission;
  assert.ok(admission.needs.includes(gateJobName), 'release admission must wait for the Mutagen gate');
  assert.equal(
    admission.steps.at(-1).env?.MUTAGEN_ENGINE_GATE_RESULT,
    `\${{ needs.${gateJobName}.result }}`,
    'the gate result must reach the source-owned admission policy as a fact',
  );

  const { admitRelease } = await import('../pipeline/release/admit-release.mjs');
  const admittedRelease = {
    plannedSourceSha: 'a'.repeat(40),
    validatedSourceSha: 'a'.repeat(40),
    ciResult: 'success',
    checksProfile: 'fast',
    environment: 'preview',
    publishServerRuntimeNeeded: false,
    publishCliBinariesNeeded: false,
    risks: { mysqlContract: false, platformServices: false, trustRoots: false },
    gates: { mysql: 'skipped', platform: 'skipped', trustRoots: 'skipped', mutagenEngine: 'success' },
  };
  assert.deepEqual(admitRelease(admittedRelease), { admitted: true });
  for (const failedGateResult of ['failure', 'cancelled', 'skipped']) {
    assert.throws(
      () => admitRelease({
        ...admittedRelease,
        gates: { ...admittedRelease.gates, mutagenEngine: failedGateResult },
      }),
      /Mutagen engine release gate/u,
      `a ${failedGateResult} Mutagen gate must fail release admission`,
    );
  }
  assert.throws(
    () => admitRelease({
      ...admittedRelease,
      gates: { mysql: 'skipped', platform: 'skipped', trustRoots: 'skipped' },
    }),
    /Mutagen engine release gate/u,
    'a missing Mutagen gate fact must fail closed',
  );

  // The pinned engine release is now published, immutable and Minisign-signed, so CI may
  // verify the acquisition path users actually reach. It stays confined to the one required
  // Lane 08 lane that already owns real workspace-sync evidence: every other CI lane must
  // remain offline, and neither owner may grow a second spelling of the acquisition.
  const testsWorkflow = YAML.parse(await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8'));
  const ciConsumers = Object.entries(testsWorkflow.jobs).filter(([, job]) =>
    (job.steps ?? []).some((step) => step.env?.HAPPIER_TEST_MUTAGEN_ENGINE_LIVE_ACQUISITION === '1'),
  );
  assert.deepEqual(
    ciConsumers.map(([id]) => id),
    ['workspace-sync-real'],
    'only the required real workspace-sync lane may consume the external engine release in ordinary CI',
  );
  const ciRuns = ciConsumers[0][1].steps.filter((step) =>
    step.env?.HAPPIER_TEST_MUTAGEN_ENGINE_LIVE_ACQUISITION === '1',
  );
  assert.equal(ciRuns.length, 1);
  assert.match(ciRuns[0].run, /yarn workspace @happier-dev\/cli-common test:mutagen-engine:live/u);
  const cliCommonPackage = JSON.parse(await readFile(join(repoRoot, 'packages/cli-common/package.json'), 'utf8'));
  assert.equal(cliCommonPackage.scripts['test:mutagen-engine:live:local'], 'node scripts/runMutagenEngineLiveTest.mjs');
  assert.equal(ciRuns[0].env?.HAPPIER_TEST_MUTAGEN_ENGINE_LIVE_ACQUISITION, '1');
  assert.equal(ciRuns[0].env?.GITHUB_TOKEN, '${{ github.token }}');
  const rootPackage = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  assert.doesNotMatch(
    String(rootPackage.scripts['test:release:contracts']),
    /mutagen/u,
    'the general release-contracts lane must not run the live network acquisition test',
  );
});

test('one bound candidate identity flows through every publisher and post-publication verification', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-channel.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  const candidate = workflow.jobs.prepare_release_candidate;

  assert.ok(candidate, 'release.yml should prepare one exact release candidate');
  assert.equal(candidate.outputs.source_sha, '${{ steps.identity.outputs.source_sha }}');
  assert.equal(candidate.outputs.build_run_id, '${{ steps.identity.outputs.build_run_id }}');
  assert.match(
    candidate.steps.map((step) => step.run ?? '').join('\n'),
    /build_run_id=\$\{GITHUB_RUN_ID\}/,
  );

  for (const jobName of [
    'deploy_ui',
    'deploy_server',
    'publish_server_runtime',
    'publish_ui_web',
    'publish_cli_binaries',
    'publish_docker',
    'deploy_website',
    'deploy_docs',
    'publish_npm',
  ]) {
    const job = workflow.jobs[jobName];
    assert.ok(job.needs.includes('prepare_release_candidate'), `${jobName} must consume the prepared candidate`);
    assert.match(
      JSON.stringify(job.with),
      /needs\.prepare_release_candidate\.outputs\.source_sha/,
      `${jobName} must use the immutable candidate SHA rather than a mutable branch`,
    );
  }

  const verify = workflow.jobs.release_verify;
  for (const dependency of [
    'deploy_ui',
    'deploy_server',
    'deploy_website',
    'deploy_docs',
    'promote_cli_binaries',
    'promote_server_runtime',
    'promote_ui_web',
    'publish_docker',
    'publish_npm',
  ]) {
    assert.ok(verify.needs.includes(dependency), `release verification must wait for ${dependency}`);
  }
  assert.equal(
    verify.with.candidate_source_sha,
    '${{ needs.prepare_release_candidate.outputs.source_sha }}',
  );
  assert.equal(
    verify.with.candidate_build_run_id,
    '${{ needs.prepare_release_candidate.outputs.build_run_id }}',
  );
  assert.equal(
    verify.with.cli_candidate_build_run_id,
    '${{ inputs.candidate_run_id }}',
    'an exact prior CLI candidate should retain its original build run identity during verification',
  );
  assert.equal(verify.with.publication_run_id, '${{ github.run_id }}');
});

test('release workflow consumes the public validation profile, projects exact-candidate notes, and emits a terminal status artifact', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-channel.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  const root = YAML.parse(await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8'));
  const inputs = root.on.workflow_dispatch.inputs;
  const plan = workflow.jobs.plan;
  const candidate = workflow.jobs.prepare_release_candidate;
  const candidateVerifier = workflow.jobs.verify_release_candidates;
  const status = workflow.jobs.release_status;
  const preflightScripts = workflow.jobs.release_preflight.steps.map((step) => step.run ?? '').join('\n');
  const sourceValidation = YAML.parse(await readFile(join(repoRoot, '.github', 'workflows', 'release-source-validation.yml'), 'utf8'));
  const ciScripts = sourceValidation.jobs.ci.steps.map((step) => step.run ?? '').join('\n');

  assert.deepEqual(inputs.validation_profile.options, ['auto', 'integrated', 'stable']);
  assert.equal(inputs.validation_profile.default, 'auto');
  assert.equal(inputs.ci_run_id.required, false);
  assert.equal(inputs.ci_run_id.default, '');
  assert.equal(inputs.ci_run_id.type, 'string');
  assert.equal(inputs.checks_profile, undefined);
  assert.match(preflightScripts, /scripts\/pipeline\/release\/validate-release-dispatch\.mjs/);
  assert.doesNotMatch(preflightScripts, /scripts\/pipeline\/release\/verify-existing-ci\.mjs/);
  assert.match(ciScripts, /scripts\/pipeline\/release\/verify-existing-ci\.mjs/);
  assert.doesNotMatch(preflightScripts, /candidate_identity_count|Unknown confirmation phrase|Unknown deploy_targets entry/);
  assert.match(
    workflow.jobs.resolve_validation_profile.steps.map((step) => step.run ?? '').join('\n'),
    /scripts\/pipeline\/release-validation\/resolve-profile\.mjs/,
    'release admission must validate the requested profile through the public contract owner',
  );
  assert.doesNotMatch(
    workflow.jobs.resolve_validation_profile.steps.map((step) => step.run ?? '').join('\n'),
    /checksProfile|validationProfiles/,
    'workflow YAML must not reconstruct the selected profile contract',
  );
  assert.equal(
    plan.outputs.validation_profile,
    '${{ needs.resolve_validation_profile.outputs.profile }}',
  );
  assert.equal(
    candidateVerifier.with.validation_profile,
    '${{ needs.plan.outputs.validation_profile }}',
  );

  assert.equal(
    candidate.outputs.release_notes_github_markdown,
    '${{ steps.release_notes.outputs.github_markdown }}',
  );
  assert.equal(
    candidate.outputs.release_notes_expo_message,
    '${{ steps.release_notes.outputs.expo_message }}',
  );
  assert.match(
    candidate.steps.map((step) => step.run ?? '').join('\n'),
    /project-release-notes\.mjs/,
    'notes must be projected from the exact checked-out candidate rather than supplied as another narrative',
  );
  assert.doesNotMatch(
    candidate.steps.map((step) => step.run ?? '').join('\n'),
    /node --input-type=module|require\('\.\/release-source\/apps\//,
    'workflow YAML must not parse or re-project release-note data',
  );
  for (const jobName of ['publish_cli_binaries', 'publish_hstack_binaries', 'publish_server_runtime', 'publish_ui_web']) {
    assert.equal(
      workflow.jobs[jobName].with.release_message,
      '${{ needs.prepare_release_candidate.outputs.release_notes_github_markdown }}',
      `${jobName} must pass the canonical GitHub/rolling notes projection`,
    );
  }
  assert.equal(
    workflow.jobs.deploy_ui.with.release_notes_id,
    '${{ inputs.release_notes_id }}',
    'the UI promoter must derive OTA copy from the approved release-notes identity',
  );
  assert.equal(
    workflow.jobs.deploy_ui.with.expo_update_message,
    undefined,
    'the release orchestrator must not introduce a second independently supplied OTA narrative',
  );

  assert.ok(status, 'release workflow must include a final status projection job');
  assert.equal(status.if, '${{ always() && inputs.dry_run != true }}');
  assert.ok(status.needs.includes('verify_release_candidates'));
  assert.ok(status.needs.includes('release_verify'));
  assert.ok(status.needs.includes('deploy_plan'));
  const projection = status.steps.find((step) => step.name === 'Project release status facts');
  assert.equal(projection.env.HMAINT_OPERATION_ID, '${{ inputs.hmaint_operation_id }}');
  assert.equal(projection.env.SOURCE_SHA, '${{ needs.prepare_release_candidate.outputs.source_sha || inputs.authorized_promotion_source_sha }}');
  assert.match(
    projection.env.REQUEST_DOCKER,
    /needs\.plan\.outputs\.changed_iroh_relay == 'true'/u,
    'a relay-only Docker publication must be requested in the terminal projection so a failed publisher cannot appear not_requested',
  );
  assert.match(projection.run, /project-release-status\.mjs[\s\S]*--mode standard/);
  assert.doesNotMatch(projection.run, /node --input-type=module|requested\(|candidate\(/);
  assert.match(
    JSON.stringify(status.steps),
    /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/,
  );
  assert.equal(
    status.steps.find((step) => String(step.uses ?? '').startsWith('actions/upload-artifact@')).with.name,
    "${{ inputs.combined_preview_production == true && format('happier-release-status-{0}', inputs.environment) || 'happier-release-status' }}",
  );
});
