import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('publish-ui-mobile-dev installs the Dagger CLI version declared by the local module', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'publish-ui-mobile-dev.yml'), 'utf8');
  const daggerConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'dagger', 'dagger.json'), 'utf8'));
  const expectedVersion = String(daggerConfig.engineVersion ?? '').replace(/^v/, '');

  assert.match(expectedVersion, /^\d+\.\d+\.\d+$/);
  const installers = Object.values(parse(workflow).jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .filter((step) => String(step.uses ?? '').startsWith('dagger/dagger-for-github@'));
  assert.ok(installers.length > 0, 'expected a Dagger installation step');
  for (const installer of installers) {
    assert.equal(installer.with?.version, expectedVersion);
  }
});
