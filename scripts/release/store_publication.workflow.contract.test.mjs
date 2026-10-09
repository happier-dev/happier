import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const workflow = fs.readFileSync(path.resolve(import.meta.dirname, '../../.github/workflows/build-ui-mobile-local.yml'), 'utf8');
const job = (name) => workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z_]+:|(?![\\s\\S]))`, 'm'))?.[1] ?? '';

test('store-only recovery uses trusted control and exact candidate notes, never a native build or binary submission', () => {
  const recovery = job('retry_store_publication');
  assert.ok(recovery, 'store-only recovery action must be runnable');
  assert.match(recovery, /ref: \$\{\{ job.workflow_sha \}\}/);
  assert.match(recovery, /ref: \$\{\{ inputs.source_ref \}\}/);
  assert.match(recovery, /project-release-notes\.mjs/);
  assert.match(recovery, /store-publish\.mjs/);
  assert.doesNotMatch(recovery, /native-build|submit\.mjs|ui-mobile-release|eas submit/);
  for (const name of ['build_android', 'build_ios', 'validate_expo_token']) {
    assert.match(job(name), /inputs.action != 'retry_store_publication'/, `${name} must not run during store-only recovery`);
  }
});

test('production Android receives the environment Play credential and a source-bound notes projection', () => {
  assert.match(job('build_android'), /GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: \$\{\{ secrets.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON \}\}/);
  assert.match(job('build_android'), /--release-notes-json/);
  assert.match(job('build_android'), /--source-sha/);
  assert.match(job('build_ios'), /--release-id/);
  assert.match(job('build_android'), /ref: \$\{\{ job.workflow_sha \}\}[\s\S]*?path: \.mobile-control/);
  assert.match(job('build_android'), /node \.mobile-control\/scripts\/pipeline\/run\.mjs/);
});
