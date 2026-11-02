import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('release workflow verifies immutable candidates before promoting preview or production channels', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-channel.yml'), 'utf8');

  const workflow = YAML.parse(raw);
  assert.equal(workflow.on.workflow_call.inputs.ci_run_id.type, 'string');
  assert.equal(workflow.on.workflow_call.inputs.ci_run_id.default, '');
  const sourceRaw = await readFile(join(repoRoot, '.github/workflows/release-source-validation.yml'), 'utf8');
  assert.match(sourceRaw, /CI_RUN_ID:\s*\$\{\{ inputs\.ci_run_id \}\}/);
  assert.match(sourceRaw, /--run-id "\$CI_RUN_ID"/);
  assert.doesNotMatch(sourceRaw, /format\(\x27--run-id \{0\}\x27/);


  assert.match(
    raw,
    /publish_server_runtime:[\s\S]*?publish_rolling:\s*false/,
    'server artifacts must remain immutable candidates until verification succeeds',
  );
  assert.match(
    raw,
    /publish_ui_web:[\s\S]*?publish_rolling:\s*false/,
    'UI artifacts must remain immutable candidates until verification succeeds',
  );
  assert.match(
    raw,
    /publish_cli_binaries:[\s\S]*?publish_rolling:\s*false/,
    'CLI artifacts must remain immutable candidates until verification succeeds',
  );
  for (const [product, publisher] of [['cli', 'cli_binaries'], ['stack', 'hstack_binaries'], ['server', 'server_runtime'], ['ui_web', 'ui_web']]) {
    const verifier = workflow.jobs[`verify_${product}_candidate`];
    assert.equal(verifier.uses, './.github/workflows/release-verify.yml');
    assert.equal(verifier.with.candidate_source_sha, '${{ needs.prepare_release_candidate.outputs.source_sha }}');
    assert.equal(verifier.with[`candidate_${product}_version`], `\${{ needs.publish_${publisher}.outputs.version }}`);
    const promotion = workflow.jobs[`promote_${publisher}`];
    assert.ok(promotion.needs.includes(`verify_${product}_candidate`));
    assert.equal(promotion.with.retry_version, `\${{ needs.publish_${publisher}.outputs.version }}`);
  }

  for (const job of ['promote_hstack_binaries', 'promote_cli_binaries', 'promote_server_runtime', 'promote_ui_web']) {
    assert.ok(workflow.jobs.release_verify.needs.includes(job));
  }
  for (const optionalJob of ['deploy_ui', 'deploy_website', 'deploy_docs', 'publish_docker', 'publish_npm']) {
    assert.ok(workflow.jobs.release_verify.needs.includes(optionalJob), `${optionalJob} must settle before channel promotion`);
  }
  assert.match(JSON.stringify(workflow.jobs.release_verify.steps), /Verify rolling references bind the candidate SHA/);
  assert.deepEqual(workflow.jobs.plan.needs, ['release_actor_guard', 'resolve_resume', 'release_preflight']);
  assert.match(String(workflow.jobs.plan.if), /needs\.release_preflight\.result == 'success'/);
  assert.match(
    raw,
    /sync_dev:[\s\S]*?needs\.release_verify\.result == 'success'[\s\S]*?needs:\s*\[plan, promote_main, prepare_release_candidate, release_verify\]/,
    'release.yml must gate the final production sync on release verification succeeding',
  );
});

test('release resume rechecks risk-selected suites after the target branch has advanced', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-channel.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  const verification = workflow.jobs.verify_cli_candidate.with;
  for (const risk of ['cli_upgrade', 'session_continuity', 'relay_upgrade']) {
    assert.match(String(verification[`risk_${risk}`]), /needs\.plan\.outputs\.risk_/);
    assert.match(String(verification[`risk_${risk}`]), /inputs\.resume_run_id != ''/);
  }
});

test('post-promotion verification receives the selected server runtime probe URL', async () => {
  const workflow = YAML.parse(await readFile(join(repoRoot, '.github', 'workflows', 'release-channel.yml'), 'utf8'));
  assert.ok(workflow.jobs.release_verify.needs.includes('deploy_server'));
  const serverProbe = workflow.jobs.release_verify.steps.find((step) => step.name === 'Verify loaded server API revision');
  assert.ok(serverProbe, 'the short signoff must retain the deployed-server identity check');
  assert.equal(serverProbe.env.CANDIDATE_SOURCE_SHA, '${{ needs.prepare_release_candidate.outputs.source_sha }}');
  assert.equal(serverProbe.env.SERVER_API_VERSION_URL, "${{ inputs.environment == 'production' && vars.HAPPIER_SERVER_API_PRODUCTION_VERSION_URL || vars.HAPPIER_SERVER_API_PREVIEW_VERSION_URL }}");
  assert.match(
    String(serverProbe.if),
    /vars\.HAPPIER_SERVER_API_(?:PRODUCTION|PREVIEW)_VERSION_URL != ''/,
    'a loaded-runtime check may only run when the selected deployment exposes a canonical probe URL',
  );
  const unobservable = workflow.jobs.release_verify.steps.find((step) => step.name === 'Record unavailable server runtime observation');
  assert.ok(unobservable, 'an unobservable loaded runtime must be reported explicitly instead of failing or claiming verification');
  assert.match(String(unobservable.if), /vars\.HAPPIER_SERVER_API_(?:PRODUCTION|PREVIEW)_VERSION_URL == ''/);
  assert.doesNotMatch(JSON.stringify(workflow.jobs.release_verify), /run_installers_smoke|run_binary_smoke|run_session_continuity/);
});

test('preview and stable releases advance a pre-promotion issue snapshot only after release verification', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-channel.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  const snapshot = workflow.jobs.snapshot_release_issues;
  const advance = workflow.jobs.advance_release_issues;

  assert.ok(snapshot.needs.includes('release_actor_guard'));
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
  assert.equal(snapshot['continue-on-error'], true);
  assert.ok(!workflow.jobs.plan.needs.includes('snapshot_release_issues'));

  assert.deepEqual(advance.needs, ['snapshot_release_issues', 'release_verify', 'release_status']);
  assert.equal(advance['continue-on-error'], true);
  assert.equal(advance.permissions.issues, 'write');
  assert.match(String(advance.if), /needs\.release_verify\.result == 'success'/);
  assert.match(String(advance.if), /always\(\)/, 'resumed releases with skipped transitive jobs still evaluate verified advancement');
  assert.match(String(advance.if), /needs\.release_status\.result == 'success'/, 'partial channel releases cannot advance availability');
  assert.ok(!workflow.jobs.release_status.needs.includes('advance_release_issues'), 'terminal status must precede optional issue reconciliation');
  assert.equal(workflow.on.workflow_call.outputs.release_complete.value, '${{ jobs.release_status.outputs.release_complete }}');
  assert.equal(workflow.jobs.release_status.outputs.release_complete, '${{ steps.admit.outputs.release_complete }}');
  const terminalAdmission = workflow.jobs.release_status.steps.find((step) => step.id === 'admit');
  assert.match(String(terminalAdmission?.run), /status\.terminal !== "complete" && status\.terminal !== "published"/);
  assert.match(String(terminalAdmission?.run), /release_complete=true/);
  assert.match(JSON.stringify(advance.steps), /reconcile-issue-stage\.mjs advance/);
  assert.match(JSON.stringify(advance.steps), /stage:source/);
  assert.match(JSON.stringify(advance.steps), /stage:dev/);
  assert.match(JSON.stringify(advance.steps), /stage:preview/);
  assert.match(JSON.stringify(advance.steps), /release preview to main/);
  assert.match(JSON.stringify(advance.steps), /inputs\.environment == 'production' && 'stage:stable' \|\| 'stage:preview'/);
});

test('release workflow binds admitted notes and source before products and moves the channel last', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-channel.yml'), 'utf8');
  const { jobs } = YAML.parse(raw);
  assert.ok(jobs.admit_release_notes.needs.includes('release_preflight'));
  for (const id of ['promote_main', 'promote_preview']) {
    assert.ok(jobs[id].needs.includes('admit_release_notes'));
    assert.ok(jobs[id].needs.includes('release_verify'));
    assert.equal(jobs[id].with.source_sha, '${{ needs.admit_release_notes.outputs.source_sha }}');
  }
  assert.ok(jobs.prepare_release_candidate.needs.includes('admit_release_notes'));
  assert.ok(!jobs.prepare_release_candidate.needs.includes('promote_main'));
  assert.ok(!jobs.prepare_release_candidate.needs.includes('promote_preview'));
  const binding = jobs.prepare_release_candidate.steps.find((step) => step.id === 'source');
  assert.match(binding.run, /--source-ref "\$AUTHORIZED_PROMOTION_SOURCE_SHA"/);
  assert.match(binding.run, /--authorized-sha "\$AUTHORIZED_PROMOTION_SOURCE_SHA"/);
});

test('release deploy planning compares deploy branches against the exact prepared candidate', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-channel.yml'), 'utf8');
  const deployPlan = raw.slice(raw.indexOf('\n  deploy_plan:'), raw.indexOf('\n  promote_main:'));

  assert.match(deployPlan, /needs:\s*\[resolve_resume, plan, prepare_release_candidate\]/);
  assert.match(deployPlan, /ref:\s*\$\{\{\s*needs\.prepare_release_candidate\.outputs\.source_sha\s*\}\}/);
  assert.match(deployPlan, /SOURCE_SHA:\s*\$\{\{\s*needs\.prepare_release_candidate\.outputs\.source_sha\s*\}\}/);
  assert.match(deployPlan, /--source-ref "\$\{SOURCE_SHA\}"/);
  assert.doesNotMatch(deployPlan, /SOURCE_REF:\s*\$\{\{\s*inputs\.environment == 'production' && 'main' \|\| 'preview'\s*\}\}/);
});

test('release workflow derives validation, notes, and terminal status from the exact bound candidate', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release-channel.yml'), 'utf8');
  const candidateVerification = raw.slice(raw.indexOf('\n  verify_cli_candidate:'), raw.indexOf('\n  promote_server_runtime:'));
  const releaseStatus = raw.slice(raw.indexOf('\n  release_status:'), raw.indexOf('\n  sync_dev:'));

  assert.match(
    raw,
    /release_preflight:[\s\S]*?validation_profile:\s*\$\{\{\s*steps\.profile\.outputs\.profile\s*\}\}[\s\S]*?checks_profile:\s*\$\{\{\s*steps\.profile\.outputs\.checks_profile\s*\}\}[\s\S]*?VALIDATION_PROFILE:\s*\$\{\{\s*inputs\.validation_profile\s*\}\}[\s\S]*?release-validation\/resolve-profile\.mjs/,
    'the trusted public-contract resolver must own normal profile and checks-profile admission before CI',
  );
  assert.match(
    raw,
    /plan:[\s\S]*?validation_profile:\s*\$\{\{\s*needs\.release_preflight\.outputs\.validation_profile\s*\}\}[\s\S]*?checks_profile:\s*\$\{\{\s*needs\.release_preflight\.outputs\.checks_profile\s*\}\}/,
  );
  assert.doesNotMatch(raw, /inputs\.checks_profile/, 'no release path may accept a caller-selected checks profile');
  assert.match(
    raw,
    /prepare_release_candidate:[\s\S]*?source_sha:[\s\S]*?release_notes_github_markdown:[\s\S]*?release_notes_expo_message:[\s\S]*?path:\s*release-source[\s\S]*?ref:\s*\$\{\{\s*steps\.source\.outputs\.authorized_sha\s*\}\}[\s\S]*?project-release-notes\.mjs/,
    'one exact candidate checkout must project both publication note variants',
  );
  assert.match(candidateVerification, /validation_profile:\s*\$\{\{\s*needs\.plan\.outputs\.validation_profile\s*\}\}/);
  assert.doesNotMatch(raw, /release_verify:[\s\S]*?needs\.plan\.outputs\.checks_profile == 'full'/);
  assert.doesNotMatch(candidateVerification, /run_(?:installers_smoke|binary_smoke|cli_update_continuity|daemon_continuity|session_continuity):/);

  for (const job of [
    'publish_server_runtime',
    'publish_ui_web',
    'publish_cli_binaries',
    'publish_hstack_binaries',
    'promote_server_runtime',
    'promote_ui_web',
    'promote_cli_binaries',
    'promote_hstack_binaries',
    'publish_npm',
  ]) {
    assert.match(
      raw,
      new RegExp(job + ':[\\s\\S]*?release_message:\\s*\\$\\{\\{\\s*needs\\.prepare_release_candidate\\.outputs\\.release_notes_github_markdown\\s*\\}\\}'),
      job + ' must consume the canonical GitHub note projection',
    );
  }

  assert.doesNotMatch(
    raw,
    /deploy_ui:[\s\S]*?expo_update_message:/,
    'promote-ui must derive Expo metadata from the exact approved release ID instead of accepting a second note input',
  );
  assert.match(releaseStatus, /if:\s*\$\{\{\s*always\(\)\s*&&\s*inputs\.dry_run != true\s*\}\}/);
  assert.doesNotMatch(raw, /supported_old_relay_compatibility/);
  assert.match(releaseStatus, /REQUEST_CLI:\s*\$\{\{[\s\S]*?needs\.plan\.outputs\.publish_cli_binaries_needed == 'true'[\s\S]*?\}\}/);
  assert.match(releaseStatus, /IMMUTABLE_VERIFICATION_RESULT:\s*\$\{\{\s*needs\.verify_release_candidates\.result\s*\}\}/);
  assert.match(releaseStatus, /CLI_RESUME_VERIFIED:\s*\$\{\{\s*needs\.verify_cli_candidate\.result == 'success'\s*\}\}/);
  assert.match(releaseStatus, /project-release-status\.mjs/);
  assert.match(releaseStatus, /GITHUB_STEP_SUMMARY/);
  assert.match(raw, /combined_preview_production:[\s\S]*?default:\s*false/);
  assert.match(
    releaseStatus,
    /actions\/upload-artifact@[\s\S]*?name:\s*\$\{\{[\s\S]*?happier-release-status-\{0\}[\s\S]*?happier-release-status[\s\S]*?\}\}/,
  );
});

test('server releases admit the focused MySQL contract and stable platform evidence before branch mutation', async () => {
  const [releaseRaw, extendedDbRaw, sourceValidationRaw] = await Promise.all([
    readFile(join(repoRoot, '.github', 'workflows', 'release-channel.yml'), 'utf8'),
    readFile(join(repoRoot, '.github', 'workflows', 'extended-db-tests.yml'), 'utf8'),
    readFile(join(repoRoot, '.github', 'workflows', 'release-source-validation.yml'), 'utf8'),
  ]);
  const release = YAML.parse(releaseRaw);
  const extendedDb = YAML.parse(extendedDbRaw);
  const sourceValidation = YAML.parse(sourceValidationRaw);
  const mysqlGate = sourceValidation.jobs.mysql;
  const platformGate = sourceValidation.jobs.platform;
  const admission = release.jobs.release_admission;

  assert.equal(mysqlGate.uses, './.github/workflows/extended-db-tests.yml');
  assert.match(mysqlGate.if, /needs\.source_plan\.outputs\.run_mysql == 'true'/);
  assert.match(mysqlGate.if, /inputs\.waive_ci != true/);
  assert.doesNotMatch(mysqlGate.if, /checks_profile/);
  assert.deepEqual(mysqlGate.with, {
    checkout_sha: '${{ needs.source_plan.outputs.source_sha }}',
    select_jobs_explicitly: true,
    run_e2e_postgres: false,
    run_e2e_mysql: false,
    run_db_contract_postgres: false,
    run_db_contract_mysql: true,
  });

  assert.equal(platformGate.uses, './.github/workflows/tests.yml');
  assert.match(platformGate.if, /needs\.source_plan\.outputs\.run_platform == 'true'/);
  assert.match(platformGate.if, /inputs\.waive_ci != true/);
  assert.equal(platformGate.with.checkout_sha, '${{ needs.source_plan.outputs.source_sha }}');
  assert.equal(platformGate.with.select_jobs_explicitly, true);
  assert.equal(platformGate.with.run_self_host_systemd, true);
  assert.equal(platformGate.with.run_self_host_launchd, true);
  assert.equal(platformGate.with.run_self_host_schtasks, true);
  assert.equal(platformGate.with.run_self_host_daemon, true);

  assert.deepEqual(admission.needs, ['plan', 'admit_release_notes']);
  const admissionScript = admission.steps.map((step) => step.run ?? '').join('\n');
  assert.match(admissionScript, /admit-release\.mjs/);
  const admissionStep = admission.steps.find((step) => String(step.name).includes('risk-selected publication admission'));
  assert.equal(admissionStep.env.RISK_MYSQL_CONTRACT, '${{ needs.plan.outputs.risk_mysql_contract }}');
  assert.equal(admissionStep.env.RISK_PLATFORM_SERVICES, '${{ needs.plan.outputs.risk_platform_services }}');
  assert.equal(admissionStep.env.RISK_TRUST_ROOTS, '${{ needs.plan.outputs.risk_trust_roots }}');
  assert.equal(admissionStep.env.PUBLISH_STACK, '${{ needs.plan.outputs.publish_stack }}');
  assert.equal(admissionStep.env.WAIVE_SOURCE_CHECKS, '${{ inputs.waive_ci }}');

  for (const jobName of ['promote_preview', 'promote_main']) {
    assert.ok(release.jobs[jobName].needs.includes('release_admission'));
    assert.match(String(release.jobs[jobName].if), /needs\.release_admission\.result == 'success'/);
  }

  for (const [inputName, jobName] of [
    ['run_e2e_postgres', 'e2e-postgres'],
    ['run_e2e_mysql', 'e2e-mysql'],
    ['run_db_contract_postgres', 'db-contract-postgres'],
    ['run_db_contract_mysql', 'db-contract-mysql'],
  ]) {
    assert.equal(extendedDb.on.workflow_call.inputs[inputName].default, true);
    assert.equal(
      extendedDb.jobs[jobName].if,
      `\${{ !inputs.select_jobs_explicitly || inputs.${inputName} }}`,
    );
  }
  assert.equal(extendedDb.jobs['db-contract-mysql'].services.mysql.image, 'mysql:8.0');
});

test('remote release uses one publication decision for publishers and their admission gates', async () => {
  const workflow = YAML.parse(await readFile(join(repoRoot, '.github', 'workflows', 'release-channel.yml'), 'utf8'));
  const outputs = workflow.jobs.plan.outputs;

  for (const [output, planOutput] of [
    ['publish_server_runtime_needed', 'publish_server_runtime'],
    ['publish_cli_binaries_needed', 'publish_cli_binaries'],
    ['publish_ui_web_needed', 'publish_ui_web'],
    ['publish_docker_relay_needed', 'publish_docker_relay'],
    ['publish_docker_dev_box_needed', 'publish_docker_dev_box'],
  ]) {
    assert.match(outputs[output], new RegExp(`steps\\.bump_plan\\.outputs\\.${planOutput} == 'true'`));
    assert.doesNotMatch(outputs[output], /steps\.plan\.outputs\.changed_|inputs\.force_deploy/);
  }
  const planner = workflow.jobs.plan.steps.find((step) => step.id === 'bump_plan');
  assert.equal(planner.env.FORCE_DEPLOY, '${{ inputs.force_deploy }}');
  assert.match(planner.run, /--force-deploy "\$\{FORCE_DEPLOY\}"/);
  assert.match(workflow.jobs.publish_server_runtime.if, /needs\.plan\.outputs\.publish_server_runtime_needed == 'true'/);
  assert.match(workflow.jobs.publish_cli_binaries.if, /needs\.plan\.outputs\.publish_cli_binaries_needed == 'true'/);
  assert.doesNotMatch(JSON.stringify(workflow.jobs.release_admission), /deploy_targets/);
});
