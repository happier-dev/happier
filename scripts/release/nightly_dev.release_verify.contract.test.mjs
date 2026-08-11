import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectReleaseStatus } from '../pipeline/release/project-release-status.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('nightly-dev uses generic unattended copy instead of requiring a human-approved release-note entry', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'nightly-dev.yml'), 'utf8');
  assert.match(raw, /prepare_release_candidate:[\s\S]*?release_message: \$\{\{ steps\.identity\.outputs\.release_message \}\}/);
  assert.match(raw, /echo "release_message=Automated nightly dev release\."/);
  assert.doesNotMatch(raw, /project-release-notes\.mjs/);
  assert.doesNotMatch(raw, /release_notes_github_markdown|release_notes_expo_message/);
});

test('nightly-dev verifies exact immutable candidates before promoting rolling references', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'nightly-dev.yml'), 'utf8');
  const releaseVerifyBlock = raw.slice(raw.indexOf('\n  release_verify:'), raw.indexOf('\n  promote_server:'));

  assert.match(raw, /prepare_release_candidate:[\s\S]*?source_sha:/);

  for (const job of ['cli', 'hstack', 'server_runtime', 'ui_web']) {
    assert.match(
      raw,
      new RegExp(`${job}:[\\s\\S]*?needs:\\s*\\[resolve_resume, prepare_release_candidate\\][\\s\\S]*?publish_rolling:\\s*false`),
      `${job} should publish an immutable candidate without moving its rolling reference`,
    );
  }

  assert.match(
    raw,
    /release_verify:[\s\S]*?needs:\s*\[prepare_release_candidate, cli, hstack, server_runtime, ui_web, resolve_validation_risk\][\s\S]*?candidate_source_sha:\s*\$\{\{ needs\.prepare_release_candidate\.outputs\.source_sha \}\}[\s\S]*?candidate_cli_version:\s*\$\{\{ needs\.cli\.outputs\.version \}\}[\s\S]*?candidate_stack_version:\s*\$\{\{ needs\.hstack\.outputs\.version \}\}[\s\S]*?candidate_server_version:\s*\$\{\{ needs\.server_runtime\.outputs\.version \}\}[\s\S]*?candidate_ui_web_version:\s*\$\{\{ needs\.ui_web\.outputs\.version \}\}/,
    'release verification should consume the exact SHA and immutable versions produced by candidate jobs',
  );

  assert.match(raw, /promote_server:[\s\S]*?needs:\s*\[prepare_release_candidate, server_runtime, release_verify\]/);
  assert.match(raw, /promote_hstack:[\s\S]*?needs:\s*\[prepare_release_candidate, hstack, promote_server\]/);
  assert.match(raw, /promote_cli:[\s\S]*?needs:\s*\[prepare_release_candidate, cli, promote_hstack\]/);
  assert.match(raw, /promote_ui_web:[\s\S]*?needs:\s*\[prepare_release_candidate, ui_web, promote_cli\]/);
  assert.match(
    raw,
    /docker:[\s\S]*?needs:\s*\[prepare_release_candidate, cli, server_runtime, promote_ui_web\][\s\S]*?server_version:\s*\$\{\{ needs\.server_runtime\.outputs\.version \}\}[\s\S]*?cli_version:\s*\$\{\{ needs\.cli\.outputs\.version \}\}/,
    'Docker should wait for promotion and consume the exact verified CLI and server candidate versions',
  );
  assert.match(raw, /verify_promoted:[\s\S]*?for tag in server-dev stack-dev cli-dev ui-web-dev/);
  assert.match(raw, /resolve_tag_commit\(\)/, 'rolling verification should dereference annotated as well as lightweight tags');

  assert.doesNotMatch(
    releaseVerifyBlock,
    /needs:\s*\[[^\]]*(?:ui_mobile|ui_desktop|docker)/,
    'candidate verification must not depend on jobs that already publish user-consumed mobile, desktop, or Docker outputs',
  );
});

test('nightly-dev propagates generic unattended copy and terminal status', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'nightly-dev.yml'), 'utf8');

  for (const job of [
    'cli',
    'hstack',
    'server_runtime',
    'ui_web',
    'promote_server',
    'promote_hstack',
    'promote_cli',
    'promote_ui_web',
  ]) {
    assert.match(
      raw,
      new RegExp(job + ':[\\s\\S]*?needs:\\s*\\[[^\\]]*prepare_release_candidate[^\\]]*\\][\\s\\S]*?release_message:\\s*\\$\\{\\{\\s*needs\\.prepare_release_candidate\\.outputs\\.release_message\\s*\\}\\}'),
      job + ' must consume the generic unattended nightly copy',
    );
  }

  assert.match(
    raw,
    /ui_mobile:[\s\S]*?release_message:\s*\$\{\{\s*needs\.prepare_release_candidate\.outputs\.release_message\s*\}\}/,
    'mobile nightly metadata must use generic unattended copy',
  );
  assert.match(
    raw,
    /ui_desktop:[\s\S]*?release_message:\s*\$\{\{\s*needs\.prepare_release_candidate\.outputs\.release_message\s*\}\}/,
    'desktop nightly publication must receive generic unattended copy',
  );
  assert.match(
    raw,
    /release_status:[\s\S]*?if:\s*\$\{\{\s*always\(\)\s*\}\}[\s\S]*?needs:\s*\[[^\]]*hstack[^\]]*promote_hstack[^\]]*\][\s\S]*?project-release-status\.mjs[\s\S]*?GITHUB_STEP_SUMMARY/,
    'nightly terminal status must include the HStack candidate and promotion outcomes',
  );
});

test('nightly status projector emits the strict summarizer contract', () => {
  const sourceSha = 'a'.repeat(40);
  const producerEnv = {
      ...process.env,
      GITHUB_RUN_ID: '12345',
      RELEASE_RUN: '12345',
      RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/12345',
      RELEASE_RUN_NAME: 'NIGHTLY — Dev Releases',
      SOURCE_SHA: sourceSha,
      CANDIDATE_RESULT: 'success',
      IMMUTABLE_VERIFICATION_RESULT: 'success',
      CLI_CANDIDATE_RESULT: 'success',
      CLI_CANDIDATE_VERSION: '0.2.10-dev.1',
      STACK_CANDIDATE_RESULT: 'success',
      STACK_CANDIDATE_VERSION: '0.2.10-dev.1',
      SERVER_CANDIDATE_RESULT: 'success',
      SERVER_CANDIDATE_VERSION: '0.2.10-dev.1',
      UI_WEB_CANDIDATE_RESULT: 'success',
      UI_WEB_CANDIDATE_VERSION: '0.2.10-dev.1',
      CLI_RESULT: 'success',
      STACK_RESULT: 'success',
      SERVER_RESULT: 'success',
      UI_WEB_RESULT: 'success',
      MOBILE_RESULT: 'success',
      DESKTOP_RESULT: 'success',
      DOCKER_RESULT: 'success',
      POST_PROMOTION_RESULT: 'success',
      VERIFY_RESULT: 'success',
      PROMOTE_SERVER_RESULT: 'success',
      PROMOTE_HSTACK_RESULT: 'success',
      PROMOTE_CLI_RESULT: 'success',
      PROMOTE_UI_WEB_RESULT: 'success',
      UI_MOBILE_RESULT: 'success',
      UI_DESKTOP_RESULT: 'success',
      VERIFY_PROMOTED_RESULT: 'success',
  };
  const summary = projectReleaseStatus('nightly', producerEnv);

  assert.deepEqual(summary.run, {
    id: 12345,
    url: 'https://github.com/happier-dev/happier/actions/runs/12345',
    name: 'NIGHTLY — Dev Releases',
  });
  assert.equal(summary.terminal, 'published');
  assert.ok(summary.surfaces.every((surface) => surface.evidence === 'verified' || surface.evidence === 'accepted'));

  const unverifiedSummary = projectReleaseStatus('nightly', {
    ...producerEnv,
    IMMUTABLE_VERIFICATION_RESULT: 'failure',
  });
  for (const id of [
    'cli-immutable-candidate',
    'hstack-immutable-candidate',
    'server-immutable-candidate',
    'ui-web-immutable-candidate',
  ]) {
    const surface = unverifiedSummary.surfaces.find((entry) => entry.id === id);
    assert.equal(surface?.state, 'partial', `${id} must not become resumable without grouped candidate verification`);
    assert.equal(surface?.identity?.verified, false);
  }
});
