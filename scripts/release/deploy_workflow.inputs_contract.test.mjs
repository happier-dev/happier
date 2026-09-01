import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function loadWorkflow(name) {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', name), 'utf8');
  return { raw, parsed: parse(raw) };
}

test('deploy workflow does not include cli/stack targets (npm publish is handled by release workflows)', async () => {
  const { parsed, raw } = await loadWorkflow('deploy.yml');
  assert.equal(parsed?.on?.push, undefined, 'deploy.yml should not deploy on push (promote workflows trigger webhooks directly)');
  const inputs = parsed?.on?.workflow_dispatch?.inputs ?? {};

  const component = inputs?.component;
  assert.equal(component?.type, 'choice');
  assert.ok(Array.isArray(component?.options), 'deploy.yml inputs.component.options must be an array');

  const options = new Set(component.options);
  assert.ok(options.has('ui'));
  assert.ok(options.has('server'));
  assert.ok(options.has('website'));
  assert.ok(options.has('docs'));
  assert.equal(options.has('cli'), false, 'deploy.yml must not expose component=cli');
  assert.equal(options.has('stack'), false, 'deploy.yml must not expose component=stack');

  // Ensure confirmation phrases cannot be used to force a cli deploy.
  assert.doesNotMatch(raw, /deploy production cli/);
  assert.doesNotMatch(raw, /deploy preview cli/);
});

test('deploy workflow trusted-ref guard admits intended deployment refs and events only', async () => {
  const { parsed } = await loadWorkflow('deploy.yml');
  const guard = parsed.jobs?.trusted_ref_guard?.steps?.find((step) => step.name === 'Admit trusted workflow control ref');
  assert.ok(guard?.run, 'deploy.yml should keep deployment ref admission in trusted_ref_guard');

  const repository = 'happier-dev/happier';
  const execute = ({ ref, event }) => spawnSync('/bin/bash', ['-c', guard.run], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CALLER_REPOSITORY: repository,
      WORKFLOW_REPOSITORY: repository,
      WORKFLOW_REF: `${repository}/.github/workflows/deploy.yml@${ref}`,
      WORKFLOW_FILE: 'deploy.yml',
      EVENT_NAME: event,
    },
    encoding: 'utf8',
  });

  for (const input of [
    { ref: 'refs/heads/dev', event: 'workflow_dispatch' },
    { ref: 'refs/heads/preview', event: 'workflow_call' },
    { ref: 'refs/heads/main', event: 'workflow_dispatch' },
    { ref: 'refs/heads/deploy/preview/ui', event: 'workflow_dispatch' },
    { ref: 'refs/heads/deploy/production/server', event: 'push' },
    { ref: 'refs/heads/deploy/preview/docs', event: 'workflow_call' },
  ]) {
    const result = execute(input);
    assert.equal(result.status, 0, `${input.event} ${input.ref} should be admitted: ${result.stderr}`);
  }

  for (const input of [
    { ref: 'refs/heads/feature/untrusted', event: 'workflow_dispatch' },
    { ref: 'refs/heads/deploy/staging/ui', event: 'workflow_dispatch' },
    { ref: 'refs/heads/deploy/preview', event: 'workflow_dispatch' },
    { ref: 'refs/heads/deploy/preview/', event: 'workflow_dispatch' },
    { ref: 'refs/pull/123/merge', event: 'pull_request' },
    { ref: 'refs/heads/deploy/preview/ui', event: 'pull_request' },
  ]) {
    const result = execute(input);
    assert.notEqual(result.status, 0, `${input.event} ${input.ref} must fail closed`);
  }
});
