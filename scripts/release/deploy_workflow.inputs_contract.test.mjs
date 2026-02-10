import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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

