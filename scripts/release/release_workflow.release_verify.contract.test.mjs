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
  assert.equal(workflow.on.workflow_dispatch.inputs.ci_run_id.type, 'string');
  assert.equal(workflow.on.workflow_dispatch.inputs.ci_run_id.default, '');
  assert.match(raw, /CI_RUN_ID:\s*\$\{\{ inputs\.ci_run_id \}\}/, 'release CI handoff must use an environment variable');
  assert.match(raw, /args\+=\(--run-id "\$CI_RUN_ID"\)/, 'release CI run id must be shell-quoted');
  assert.doesNotMatch(raw, /format\(\x27--run-id \{0\}\x27/, 'release CI run id must not be interpolated into an unquoted shell fragment');

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
  assert.match(
    raw,
    /verify_release_candidates:[\s\S]*?needs:\s*\[plan, prepare_release_candidate, publish_cli_binaries, publish_hstack_binaries, publish_server_runtime, publish_ui_web\][\s\S]*?candidate_source_sha:\s*\$\{\{\s*needs\.prepare_release_candidate\.outputs\.source_sha\s*\}\}[\s\S]*?candidate_cli_version:\s*\$\{\{\s*needs\.publish_cli_binaries\.outputs\.version\s*\}\}[\s\S]*?candidate_stack_version:\s*\$\{\{\s*needs\.publish_hstack_binaries\.outputs\.version\s*\}\}[\s\S]*?candidate_server_version:\s*\$\{\{\s*needs\.publish_server_runtime\.outputs\.version\s*\}\}[\s\S]*?candidate_ui_web_version:\s*\$\{\{\s*needs\.publish_ui_web\.outputs\.version\s*\}\}/,
    'the verifier must consume the exact source and immutable versions emitted by the candidate jobs',
  );
  assert.match(
    raw,
    /promote_server_runtime:[\s\S]*?needs:\s*\[prepare_release_candidate, verify_release_candidates, publish_server_runtime\][\s\S]*?retry_version:\s*\$\{\{\s*needs\.publish_server_runtime\.outputs\.version\s*\}\}/,
  );
  assert.match(
    raw,
    /promote_ui_web:[\s\S]*?needs:\s*\[prepare_release_candidate, verify_release_candidates, publish_ui_web, promote_server_runtime\][\s\S]*?retry_version:\s*\$\{\{\s*needs\.publish_ui_web\.outputs\.version\s*\}\}/,
  );
  assert.match(
    raw,
    /promote_cli_binaries:[\s\S]*?needs:\s*\[prepare_release_candidate, verify_release_candidates, publish_cli_binaries, promote_ui_web\][\s\S]*?retry_version:\s*\$\{\{\s*needs\.publish_cli_binaries\.outputs\.version\s*\}\}/,
  );
  assert.match(
    raw,
    /release_verify:[\s\S]*?needs:\s*\[plan, prepare_release_candidate, deploy_server, publish_hstack_binaries, promote_hstack_binaries, promote_cli_binaries, promote_server_runtime, promote_ui_web, publish_docker, publish_npm\][\s\S]*?uses:\s*\.\/\.github\/workflows\/release-verify\.yml/,
    'post-promotion checks should verify selected release surfaces after candidate verification and promotion',
  );
  assert.match(
    raw,
    /plan:[\s\S]*?needs:\s*\[release_actor_guard, resolve_resume, resolve_validation_profile, ci\][\s\S]*?needs\.resolve_resume\.result == 'success'[\s\S]*?needs\.resolve_validation_profile\.result == 'success'[\s\S]*?needs\.ci\.result == 'success'/,
    'release.yml planning must fail closed unless resume admission, the canonical profile, and pre-release CI admission succeed',
  );
  assert.match(
    raw,
    /sync_dev:[\s\S]*?needs\.release_verify\.result == 'success'[\s\S]*?needs:\s*\[plan, promote_main, prepare_release_candidate, release_verify\]/,
    'release.yml must gate the final production sync on release verification succeeding',
  );
});

test('post-promotion verification receives the selected server runtime probe URL', async () => {
  const workflow = YAML.parse(await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8'));
  assert.ok(workflow.jobs.release_verify.needs.includes('deploy_server'));
  assert.equal(workflow.jobs.release_verify.with.verify_deploy_server, "${{ needs.deploy_server.result == 'success' }}");
  assert.equal(
    workflow.jobs.release_verify.with.server_api_version_url,
    "${{ inputs.environment == 'production' && vars.HAPPIER_SERVER_API_PRODUCTION_VERSION_URL || vars.HAPPIER_SERVER_API_PREVIEW_VERSION_URL }}",
  );
  assert.equal(workflow.jobs.release_verify.with.validation_profile, 'integrated');
  for (const suite of [
    'run_installers_smoke',
    'run_binary_smoke',
    'run_cli_update_continuity',
    'run_daemon_continuity',
    'run_session_continuity',
    'run_release_assets_docker',
    'run_self_host_systemd',
    'run_self_host_launchd',
    'run_self_host_schtasks',
    'run_self_host_daemon',
  ]) {
    assert.equal(workflow.jobs.release_verify.with[suite], undefined, `${suite} should be owned by the integrated profile`);
  }
  assert.doesNotMatch(
    String(workflow.jobs.release_verify.if),
    /checks_profile == 'full'/,
    'post-promotion verification must run for preview and stable releases',
  );
});

test('preview and stable releases advance a pre-promotion issue snapshot only after release verification', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
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

  assert.deepEqual(advance.needs, ['snapshot_release_issues', 'release_verify']);
  assert.equal(advance['continue-on-error'], true);
  assert.equal(advance.permissions.issues, 'write');
  assert.match(String(advance.if), /needs\.release_verify\.result == 'success'/);
  assert.match(JSON.stringify(advance.steps), /reconcile-issue-stage\.mjs advance/);
  assert.match(JSON.stringify(advance.steps), /stage:source/);
  assert.match(JSON.stringify(advance.steps), /stage:dev/);
  assert.match(JSON.stringify(advance.steps), /stage:preview/);
  assert.match(JSON.stringify(advance.steps), /release preview to main/);
  assert.match(JSON.stringify(advance.steps), /inputs\.environment == 'production' && 'stage:stable' \|\| 'stage:preview'/);
});

test('release workflow admits exact candidate notes before branch promotion and rechecks the promoted candidate', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  const notesAdmission = raw.slice(raw.indexOf('\n  admit_release_notes:'), raw.indexOf('\n  promote_main:'));

  assert.match(notesAdmission, /admit_release_notes:[\s\S]*?needs:\s*\[plan\][\s\S]*?ref:\s*\$\{\{ needs\.plan\.outputs\.source_sha \}\}[\s\S]*?Project approved release notes from exact candidate[\s\S]*?project-release-notes\.mjs/);
  assert.doesNotMatch(notesAdmission, /resolve-authorized-release-source\.mjs/, 'planning already binds and verifies the exact authorized source');
  assert.match(
    raw,
    /promote_main:[\s\S]*?needs:\s*\[plan, release_admission, admit_release_notes\][\s\S]*?source_sha:\s*\$\{\{\s*needs\.admit_release_notes\.outputs\.source_sha\s*\}\}/,
    'production branch promotion must wait for approved notes and use that exact admitted source',
  );
  assert.match(
    raw,
    /promote_preview:[\s\S]*?needs:\s*\[plan, release_admission, admit_release_notes\][\s\S]*?source_sha:\s*\$\{\{\s*needs\.admit_release_notes\.outputs\.source_sha\s*\}\}/,
    'preview branch promotion must wait for approved notes and use that exact admitted source',
  );
  assert.match(
    raw,
    /prepare_release_candidate:[\s\S]*?needs:\s*\[plan, promote_preview, promote_main\][\s\S]*?SOURCE_REF:\s*\$\{\{\s*inputs\.environment == 'production' && 'main' \|\| 'preview'\s*\}\}[\s\S]*?resolve-authorized-release-source\.mjs/,
    'post-promotion candidate binding must still prove the promoted target points at the admitted SHA',
  );
});

test('release deploy planning compares deploy branches against the exact prepared candidate', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  const deployPlan = raw.slice(raw.indexOf('\n  deploy_plan:'), raw.indexOf('\n  promote_main:'));

  assert.match(deployPlan, /needs:\s*\[plan, promote_preview, promote_main, prepare_release_candidate\]/);
  assert.match(deployPlan, /ref:\s*\$\{\{\s*needs\.prepare_release_candidate\.outputs\.source_sha\s*\}\}/);
  assert.match(deployPlan, /SOURCE_SHA:\s*\$\{\{\s*needs\.prepare_release_candidate\.outputs\.source_sha\s*\}\}/);
  assert.match(deployPlan, /--source-ref "\$\{SOURCE_SHA\}"/);
  assert.doesNotMatch(deployPlan, /SOURCE_REF:\s*\$\{\{\s*inputs\.environment == 'production' && 'main' \|\| 'preview'\s*\}\}/);
});

test('release workflow derives validation, notes, and terminal status from the exact bound candidate', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  const candidateVerification = raw.slice(raw.indexOf('\n  verify_release_candidates:'), raw.indexOf('\n  promote_server_runtime:'));
  const releaseStatus = raw.slice(raw.indexOf('\n  release_status:'), raw.indexOf('\n  sync_dev:'));

  assert.match(
    raw,
    /resolve_validation_profile:[\s\S]*?profile:\s*\$\{\{\s*steps\.resolve\.outputs\.profile\s*\}\}[\s\S]*?checks_profile:\s*\$\{\{\s*steps\.resolve\.outputs\.checks_profile\s*\}\}[\s\S]*?VALIDATION_PROFILE:\s*\$\{\{\s*inputs\.validation_profile\s*\}\}[\s\S]*?release-validation\/resolve-profile\.mjs/,
    'the trusted public-contract resolver must own normal profile and checks-profile admission before CI',
  );
  assert.match(
    raw,
    /plan:[\s\S]*?validation_profile:\s*\$\{\{\s*needs\.resolve_validation_profile\.outputs\.profile\s*\}\}[\s\S]*?checks_profile:\s*\$\{\{\s*needs\.resolve_validation_profile\.outputs\.checks_profile\s*\}\}/,
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
  assert.match(releaseStatus, /REQUEST_CLI:\s*\$\{\{\s*needs\.plan\.outputs\.publish_cli_binaries_needed == 'true'\s*\}\}/);
  assert.match(releaseStatus, /IMMUTABLE_VERIFICATION_RESULT:\s*\$\{\{\s*needs\.verify_release_candidates\.result\s*\}\}/);
  assert.match(releaseStatus, /CLI_RESUME_VERIFIED:\s*\$\{\{\s*needs\.verify_resume_candidates\.outputs\.cli_verified\s*\}\}/);
  assert.match(releaseStatus, /project-release-status\.mjs/);
  assert.match(releaseStatus, /GITHUB_STEP_SUMMARY/);
  assert.match(releaseStatus, /actions\/upload-artifact@[\s\S]*?name:\s*happier-release-status/);
});

test('server releases admit the focused MySQL contract and stable platform evidence before branch mutation', async () => {
  const [releaseRaw, extendedDbRaw] = await Promise.all([
    readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8'),
    readFile(join(repoRoot, '.github', 'workflows', 'extended-db-tests.yml'), 'utf8'),
  ]);
  const release = YAML.parse(releaseRaw);
  const extendedDb = YAML.parse(extendedDbRaw);
  const mysqlGate = release.jobs.mysql_db_contract;
  const platformGate = release.jobs.platform_service_validation;
  const admission = release.jobs.release_admission;

  assert.equal(mysqlGate.uses, './.github/workflows/extended-db-tests.yml');
  assert.match(mysqlGate.if, /needs\.plan\.outputs\.publish_server_runtime_needed == 'true'/);
  assert.match(mysqlGate.if, /needs\.plan\.outputs\.risk_mysql_contract == 'true'/);
  assert.doesNotMatch(mysqlGate.if, /checks_profile/);
  assert.deepEqual(mysqlGate.with, {
    run_e2e_postgres: false,
    run_e2e_mysql: false,
    run_db_contract_postgres: false,
    run_db_contract_mysql: true,
  });

  assert.equal(platformGate.uses, './.github/workflows/tests.yml');
  assert.match(platformGate.if, /needs\.plan\.outputs\.risk_platform_services == 'true'/);
  assert.equal(platformGate.with.run_self_host_systemd, true);
  assert.equal(platformGate.with.run_self_host_launchd, true);
  assert.equal(platformGate.with.run_self_host_schtasks, true);
  assert.equal(platformGate.with.run_self_host_daemon, true);

  assert.deepEqual(admission.needs, ['plan', 'mysql_db_contract', 'platform_service_validation', 'trust_root_validation']);
  const admissionScript = admission.steps.map((step) => step.run ?? '').join('\n');
  assert.match(admissionScript, /admit-release\.mjs/);
  const admissionStep = admission.steps.find((step) => String(step.name).includes('risk-selected publication admission'));
  assert.equal(admissionStep.env.RISK_MYSQL_CONTRACT, '${{ needs.plan.outputs.risk_mysql_contract }}');
  assert.equal(admissionStep.env.RISK_PLATFORM_SERVICES, '${{ needs.plan.outputs.risk_platform_services }}');
  assert.equal(admissionStep.env.RISK_TRUST_ROOTS, '${{ needs.plan.outputs.risk_trust_roots }}');

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
    assert.match(extendedDb.jobs[jobName].if, new RegExp(`github\\.event_name != 'workflow_call' \\|\\| inputs\\.${inputName}`));
  }
  assert.equal(extendedDb.jobs['db-contract-mysql'].services.mysql.image, 'mysql:8.0');
});

test('remote release uses one publication decision for publishers and their admission gates', async () => {
  const workflow = YAML.parse(await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8'));
  const outputs = workflow.jobs.plan.outputs;

  assert.match(outputs.publish_server_runtime_needed, /inputs\.force_deploy == true/);
  assert.match(outputs.publish_server_runtime_needed, /steps\.plan\.outputs\.changed_server == 'true'/);
  assert.match(outputs.publish_cli_binaries_needed, /inputs\.force_deploy == true/);
  assert.match(outputs.publish_cli_binaries_needed, /steps\.plan\.outputs\.changed_cli == 'true'/);
  assert.match(workflow.jobs.publish_server_runtime.if, /needs\.plan\.outputs\.publish_server_runtime_needed == 'true'/);
  assert.match(workflow.jobs.publish_cli_binaries.if, /needs\.plan\.outputs\.publish_cli_binaries_needed == 'true'/);
  assert.doesNotMatch(JSON.stringify(workflow.jobs.mysql_db_contract), /deploy_targets/);
  assert.doesNotMatch(JSON.stringify(workflow.jobs.platform_service_validation), /deploy_targets/);
});
