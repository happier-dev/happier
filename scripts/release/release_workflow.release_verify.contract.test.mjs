import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('release workflow verifies immutable candidates before promoting preview or production channels', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');

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
    /release_verify:[\s\S]*?needs:\s*\[plan, prepare_release_candidate, publish_hstack_binaries, promote_hstack_binaries, promote_cli_binaries, promote_server_runtime, promote_ui_web, publish_docker, publish_npm\][\s\S]*?uses:\s*\.\/\.github\/workflows\/release-verify\.yml/,
    'full checks should verify the promoted projections after candidate verification and promotion',
  );
  assert.match(
    raw,
    /plan:[\s\S]*?needs:\s*\[release_actor_guard, resolve_validation_profile, ci\][\s\S]*?needs\.resolve_validation_profile\.result == 'success'[\s\S]*?needs\.ci\.result == 'success'/,
    'release.yml planning must fail closed unless the canonical profile and its pre-release CI gate succeed',
  );
  assert.match(
    raw,
    /sync_dev:[\s\S]*?needs\.release_verify\.result == 'success'[\s\S]*?needs:\s*\[plan, promote_main, prepare_release_candidate, release_verify\]/,
    'release.yml must gate the final production sync on release verification succeeding',
  );
});

test('release workflow admits exact candidate notes before branch promotion and rechecks the promoted candidate', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  const notesAdmission = raw.slice(raw.indexOf('\n  admit_release_notes:'), raw.indexOf('\n  promote_main:'));

  assert.match(notesAdmission, /admit_release_notes:[\s\S]*?needs:\s*\[plan\][\s\S]*?resolve-authorized-release-source\.mjs[\s\S]*?Project approved release notes from exact candidate[\s\S]*?project-release-notes\.mjs/);
  assert.match(
    raw,
    /promote_main:[\s\S]*?needs:\s*\[plan, admit_release_notes\][\s\S]*?source_sha:\s*\$\{\{\s*needs\.admit_release_notes\.outputs\.source_sha\s*\}\}/,
    'production branch promotion must wait for approved notes and use that exact admitted source',
  );
  assert.match(
    raw,
    /promote_preview:[\s\S]*?needs:\s*\[plan, admit_release_notes\][\s\S]*?source_sha:\s*\$\{\{\s*needs\.admit_release_notes\.outputs\.source_sha\s*\}\}/,
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
    /resolve_validation_profile:[\s\S]*?profile:\s*\$\{\{\s*steps\.resolve\.outputs\.profile\s*\}\}[\s\S]*?checks_profile:\s*\$\{\{\s*steps\.resolve\.outputs\.checks_profile\s*\}\}[\s\S]*?VALIDATION_PROFILE:\s*\$\{\{\s*inputs\.validation_profile\s*\}\}[\s\S]*?profile\?\.normalRelease[\s\S]*?profile\?\.checksProfile/,
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
  assert.match(raw, /release_verify:[\s\S]*?needs\.plan\.outputs\.checks_profile == 'full'/);
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

  assert.match(
    raw,
    /deploy_ui:[\s\S]*?expo_update_message:\s*\$\{\{\s*needs\.prepare_release_candidate\.outputs\.release_notes_expo_message\s*\}\}/,
    'Expo metadata must use the bounded plain-text projection',
  );
  assert.match(releaseStatus, /if:\s*\$\{\{\s*always\(\)\s*\}\}/);
  assert.doesNotMatch(raw, /supported_old_relay_compatibility/);
  assert.match(releaseStatus, /VALIDATION_PROFILE:\s*\$\{\{\s*needs\.plan\.outputs\.validation_profile\s*\}\}/);
  assert.match(releaseStatus, /PUBLISH_CLI:\s*\$\{\{\s*needs\.plan\.outputs\.publish_cli\s*\}\}/);
  assert.match(releaseStatus, /requestedSurfaces: definitions\.map\(\(\{ id, evidence \}\) => \(\{ id, requested: Boolean\(requested\[id\]\), required: true, evidence \}\)\)/);
  assert.match(releaseStatus, /summarize-release-status\.mjs/);
  assert.match(releaseStatus, /GITHUB_STEP_SUMMARY/);
  assert.match(releaseStatus, /actions\/upload-artifact@[\s\S]*?name:\s*happier-release-status/);
});
