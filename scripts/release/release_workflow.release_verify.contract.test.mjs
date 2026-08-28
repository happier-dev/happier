import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('release workflow verifies immutable candidates before promoting preview or production channels', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  const candidateVerify = workflow.jobs.verify_release_candidates;
  const releaseVerify = workflow.jobs.release_verify;

  assert.equal(workflow.jobs.publish_cli_binaries.with.publish_rolling, false);
  assert.equal(workflow.jobs.publish_hstack_binaries.with.publish_rolling, false);
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
    'publish_server_runtime',
    'publish_ui_web',
  ]);
  assert.equal(candidateVerify.with.candidate_source_sha, '${{ needs.prepare_release_candidate.outputs.source_sha }}');
  assert.equal(candidateVerify.with.candidate_cli_version, '${{ needs.publish_cli_binaries.outputs.version }}');
  assert.equal(candidateVerify.with.candidate_stack_version, '${{ needs.publish_hstack_binaries.outputs.version }}');
  assert.equal(candidateVerify.with.candidate_server_version, '${{ needs.publish_server_runtime.outputs.version }}');
  assert.equal(candidateVerify.with.candidate_ui_web_version, '${{ needs.publish_ui_web.outputs.version }}');
  assert.ok(workflow.jobs.promote_server_runtime.needs.includes('verify_release_candidates'));
  assert.ok(workflow.jobs.promote_ui_web.needs.includes('promote_server_runtime'));
  assert.ok(workflow.jobs.promote_cli_binaries.needs.includes('promote_ui_web'));

  assert.equal(releaseVerify.uses, './.github/workflows/release-verify.yml');
  assert.doesNotMatch(releaseVerify.if, /inputs\.checks_profile/);
  assert.match(
    releaseVerify.if,
    /needs\.promote_cli_binaries\.result == 'success' \|\| needs\.promote_cli_binaries\.result == 'skipped'/,
  );
  assert.match(
    raw,
    /release_verify:[\s\S]*?channel:\s*\$\{\{\s*inputs\.environment == 'production' && 'production' \|\| 'preview'\s*\}\}/,
    'release.yml should map production releases to production verification and preview releases to preview verification',
  );
  assert.match(
    raw,
    /plan:[\s\S]*?needs:\s*\[release_actor_guard, resolve_resume, resolve_validation_profile, ci\][\s\S]*?needs\.resolve_resume\.result == 'success'[\s\S]*?needs\.resolve_validation_profile\.result == 'success'[\s\S]*?needs\.ci\.result == 'success'/,
    'release.yml should compute canonical publication decisions after profile resolution and general CI',
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
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  const snapshot = workflow.jobs.snapshot_release_issues;
  const advance = workflow.jobs.advance_release_issues;

  assert.deepEqual(snapshot.needs, ['release_actor_guard']);
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

  assert.deepEqual(advance.needs, ['snapshot_release_issues', 'release_verify']);
  assert.equal(advance.permissions.issues, 'write');
  assert.match(String(advance.if), /needs\.release_verify\.result == 'success'/);
  assert.equal(advance['continue-on-error'], true);
  assert.match(JSON.stringify(advance.steps), /reconcile-issue-stage\.mjs advance/);
  assert.match(JSON.stringify(advance.steps), /stage:source/);
  assert.match(JSON.stringify(advance.steps), /stage:dev/);
  assert.match(JSON.stringify(advance.steps), /stage:preview/);
  assert.match(JSON.stringify(advance.steps), /release preview to main/);
  assert.match(JSON.stringify(advance.steps), /inputs\.environment == 'production' && 'stage:stable' \|\| 'stage:preview'/);
});

test('post-promotion verification receives the selected server runtime probe URL', async () => {
  const workflow = YAML.parse(await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8'));
  assert.equal(
    workflow.jobs.release_verify.with.server_api_version_url,
    "${{ inputs.environment == 'production' && vars.HAPPIER_SERVER_API_PRODUCTION_VERSION_URL || vars.HAPPIER_SERVER_API_PREVIEW_VERSION_URL }}",
  );
});

test('release validation retains a risk-selected pre-publication platform gate while post-publication verification stays profile-bounded', async () => {
  const [raw, testsRaw] = await Promise.all([
    readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8'),
    readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8'),
  ]);
  const workflow = YAML.parse(raw);
  const testsWorkflow = YAML.parse(testsRaw);
  const prePublicationGate = workflow.jobs.platform_service_validation.with.run_self_host_systemd;

  assert.equal(workflow.jobs.platform_service_validation.uses, './.github/workflows/tests.yml');
  assert.match(workflow.jobs.platform_service_validation.if, /needs\.plan\.outputs\.risk_platform_services == 'true'/);
  assert.match(
    workflow.jobs.platform_service_validation.if,
    /needs\.plan\.outputs\.publish_server_runtime_needed == 'true'/,
  );
  assert.match(
    workflow.jobs.platform_service_validation.if,
    /needs\.plan\.outputs\.publish_cli_binaries_needed == 'true'/,
  );

  for (const inputName of [
    'run_self_host_systemd',
    'run_self_host_launchd',
    'run_self_host_schtasks',
    'run_self_host_daemon',
  ]) {
    assert.equal(workflow.jobs.ci.with, undefined, 'release admission should reuse exact-SHA push CI rather than dispatch another general matrix');
    assert.equal(
      workflow.jobs.platform_service_validation.with[inputName],
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

test('database-affecting server releases invoke the existing MySQL 8 contract workflow before release mutation', async () => {
  const [releaseRaw, extendedDbRaw] = await Promise.all([
    readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8'),
    readFile(join(repoRoot, '.github', 'workflows', 'extended-db-tests.yml'), 'utf8'),
  ]);
  const release = YAML.parse(releaseRaw);
  const extendedDb = YAML.parse(extendedDbRaw);
  const mysqlGate = release.jobs.mysql_db_contract;

  assert.equal(
    mysqlGate.uses,
    './.github/workflows/extended-db-tests.yml',
    'release should reuse the existing extended database workflow',
  );
  assert.doesNotMatch(mysqlGate.if, /checks_profile/, 'MySQL validation should not disappear from integrated server releases');
  assert.match(
    mysqlGate.if,
    /needs\.plan\.outputs\.publish_server_runtime_needed == 'true'/,
    'MySQL validation should use the canonical actual server publication decision',
  );
  assert.match(mysqlGate.if, /needs\.plan\.outputs\.risk_mysql_contract == 'true'/);
  assert.doesNotMatch(
    mysqlGate.if,
    /dry_run/,
    'a full dry-run should still execute validation while the existing mutation jobs remain disabled',
  );
  assert.deepEqual(
    mysqlGate.with,
    {
      run_e2e_postgres: false,
      run_e2e_mysql: false,
      run_db_contract_postgres: false,
      run_db_contract_mysql: true,
    },
    'the release invocation should run the material MySQL contract rather than the unrelated extended matrix',
  );

  assert.ok(
    mysqlGate.needs.includes('plan'),
    'MySQL validation should run after canonical release planning',
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
  assert.ok(release.jobs.release_admission.needs.includes('mysql_db_contract'));
  assert.ok(release.jobs.release_admission.needs.includes('platform_service_validation'));
  assert.ok(release.jobs.release_admission.needs.includes('trust_root_validation'));

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
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
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

  for (const gateJobName of ['mysql_db_contract', 'platform_service_validation', 'release_verify']) {
    assert.doesNotMatch(
      JSON.stringify(workflow.jobs[gateJobName]),
      /deploy_targets/,
      `${gateJobName} must not reimplement publication applicability from requested targets`,
    );
  }
});

test('publication admission requires full stable checks and risk-selected server evidence', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  const admission = workflow.jobs.release_admission;
  const admissionScript = admission.steps.map((step) => step.run ?? '').join('\n');

  assert.ok(admission, 'release.yml should have one canonical release admission job');
  assert.ok(admission.needs.includes('plan'));
  assert.ok(admission.needs.includes('trust_root_validation'));
  assert.equal(workflow.on.workflow_dispatch.inputs.approve_public_sdk_release.type, 'boolean');
  assert.equal(workflow.on.workflow_dispatch.inputs.plugin_sdk_ready.type, 'boolean');
  assert.equal(workflow.on.workflow_dispatch.inputs.sdk_auth_readiness.type, 'choice');
  assert.equal(
    workflow.jobs.publish_npm.with.approve_public_sdk_release,
    '${{ inputs.approve_public_sdk_release }}',
    'the exact packed public SDK candidate must consume the reviewed maintainer decision',
  );
  assert.equal(workflow.jobs.release_admission.steps.at(-1).env.SDK_API_CLASSIFICATION,
    '${{ inputs.sdk_api_classification }}');
  assert.match(
    workflow.jobs.release_admission.steps.map((step) => step.run ?? '').join('\n'),
    /scripts\/pipeline\/release\/admit-release\.mjs/u,
  );
  assert.equal(workflow.jobs.release_admission.steps.at(-1).env.SDK_API_HUMAN_REVIEW_REQUIRED,
    '${{ needs.plan.outputs.sdk_api_human_review_required }}');
  assert.match(
    admissionScript,
    /scripts\/pipeline\/release\/admit-release\.mjs/,
    'release mutation admission must delegate stable and risk-selected policy to the source owner',
  );
  assert.doesNotMatch(admissionScript, /RISK_TRUST_ROOTS.*TRUST_ROOT_GATE_RESULT.*success/s);

  const trustGate = workflow.jobs.trust_root_validation;
  assert.match(trustGate.if, /needs\.plan\.outputs\.risk_trust_roots == 'true'/);
  assert.equal(trustGate.steps[0].with.ref, '${{ inputs.authorized_promotion_source_sha }}');
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

test('one bound candidate identity flows through every publisher and post-publication verification', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
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
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  const inputs = workflow.on.workflow_dispatch.inputs;
  const plan = workflow.jobs.plan;
  const candidate = workflow.jobs.prepare_release_candidate;
  const candidateVerifier = workflow.jobs.verify_release_candidates;
  const status = workflow.jobs.release_status;
  const ciScripts = workflow.jobs.ci.steps.map((step) => step.run ?? '').join('\n');

  assert.deepEqual(inputs.validation_profile.options, ['integrated', 'stable']);
  assert.equal(inputs.validation_profile.default, 'integrated');
  assert.equal(inputs.checks_profile, undefined);
  assert.match(ciScripts, /scripts\/pipeline\/release\/validate-release-dispatch\.mjs/);
  assert.match(ciScripts, /scripts\/pipeline\/release\/verify-existing-ci\.mjs/);
  assert.doesNotMatch(ciScripts, /candidate_identity_count|Unknown confirmation phrase|Unknown deploy_targets entry/);
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
  assert.match(projection.run, /project-release-status\.mjs[\s\S]*--mode standard/);
  assert.doesNotMatch(projection.run, /node --input-type=module|requested\(|candidate\(/);
  assert.match(
    JSON.stringify(status.steps),
    /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/,
  );
  assert.equal(
    status.steps.find((step) => String(step.uses ?? '').startsWith('actions/upload-artifact@')).with.name,
    'happier-release-status',
  );
});
