import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { parse } from 'yaml';
const workflow = name => parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
test('weekly dev builds cannot publish or receive signing secrets', () => {
  const w = workflow('release-build-dry-run');
  assert.equal(w.on.schedule.length, 1);
  assert.equal(w.on.schedule[0].cron.split(' ').at(-1), '1');
  assert.ok('workflow_dispatch' in w.on);
  assert.deepEqual(w.permissions, { contents: 'read' });
  assert.equal(w.jobs.docker.uses, './.github/workflows/publish-docker.yml');
  assert.equal(w.jobs.docker.with.build_only, true);
  assert.equal(w.jobs.desktop.uses, './.github/workflows/build-tauri.yml');
  assert.equal(w.jobs.desktop.with.preparation_only, true);
  assert.equal(w.jobs.desktop.with.publish_release, false);
  for (const job of Object.values(w.jobs)) {
    assert.equal(job.secrets, undefined);
    assert.equal(job.environment, undefined);
  }
  assert.match(JSON.stringify(w.jobs.cli), /build-cli-binaries.mjs/);
  const docker = workflow('publish-docker');
  assert.match(docker.jobs.trusted_ref_guard.if, /inputs.build_only != true/);
  assert.match(JSON.stringify(docker.jobs.build_only), /--no-push/);
});
test('Docker no-push builds real build commands without registry login or Sentry writes', () => {
  const out = execFileSync(process.execPath, ['scripts/pipeline/docker/publish-images.mjs', '--channel', 'dev', '--dry-run', '--no-push'], { encoding: 'utf8', env: { ...process.env, SENTRY_AUTH_TOKEN: '' } });
  assert.match(out, /buildx build/);
  assert.match(out, /--output type=cacheonly/);
  assert.doesNotMatch(out, /--push|docker login/);
});
