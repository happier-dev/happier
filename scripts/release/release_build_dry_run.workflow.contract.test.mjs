import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = (name) => parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));

test('the weekly dev build cannot publish or receive signing secrets', () => {
  const w = workflow('release-build-dry-run');
  assert.equal(w.on.schedule.length, 1);
  assert.ok('workflow_dispatch' in w.on);
  assert.deepEqual(w.permissions, { contents: 'read' });
  assert.equal(w.jobs.docker.uses, './.github/workflows/publish-docker.yml');
  assert.equal(w.jobs.docker.with.build_only, true);
  for (const job of Object.values(w.jobs)) {
    assert.equal(job.secrets, undefined);
    assert.equal(job.environment, undefined);
  }
  // GitHub admits a reusable call only when the caller grants every permission its jobs declare.
  assert.deepEqual(w.jobs.docker.permissions, { contents: 'read', packages: 'write' });

  const docker = workflow('publish-docker');
  assert.match(docker.jobs.trusted_ref_guard.if, /inputs\.build_only != true/);
  const buildOnly = docker.jobs.build_only;
  assert.match(buildOnly.if, /inputs\.build_only == true/);
  assert.equal(buildOnly.environment, undefined);
  assert.deepEqual(buildOnly.permissions, { contents: 'read' });
  const source = JSON.stringify(buildOnly.steps);
  assert.match(source, /--no-push/);
  assert.doesNotMatch(source, /secrets\.|login-action/);
});
