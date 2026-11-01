import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadInstallActionSteps() {
  const raw = readFileSync(join(repoRoot, '.github', 'actions', 'install-yarn-dependencies', 'action.yml'), 'utf8');
  return YAML.parse(raw).runs.steps;
}

function writeFixtureFile(root, relativePath, contents) {
  const path = join(root, ...relativePath.split('/'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

test('a restored dependency cache drops bundled workspace copies and keeps third-party packages', () => {
  const steps = loadInstallActionSteps();
  const restoreIndex = steps.findIndex((step) => step.id === 'dependencies');
  const verifyIndex = steps.findIndex((step) => step.name === 'Verify restored dependencies and refresh workspace setup');
  const dropIndex = steps.findIndex((step) => typeof step.run === 'string' && step.run.includes('node_modules/@happier-dev'));
  assert.ok(dropIndex > restoreIndex && dropIndex < verifyIndex, 'bundled workspace copies must be dropped between cache restore and verification');
  const drop = steps[dropIndex];
  assert.equal(drop.if, "steps.dependencies.outputs.cache-hit == 'true'");

  const root = mkdtempSync(join(tmpdir(), 'happier-install-cache-bundles-'));
  try {
    // Build outputs that a restored cache may carry from an older source tree.
    writeFixtureFile(root, 'apps/cli/node_modules/@happier-dev/cli-common/dist/service/index.js', 'export {};\n');
    writeFixtureFile(root, 'apps/stack/node_modules/@happier-dev/cli-common/package.json', '{}\n');
    // Installed third-party dependencies, including another scope, stay cached.
    writeFixtureFile(root, 'apps/cli/node_modules/zod/package.json', '{}\n');
    writeFixtureFile(root, 'apps/cli/node_modules/@types/node/package.json', '{}\n');
    writeFixtureFile(root, 'node_modules/@happier-dev/cli-common/package.json', '{}\n');

    const result = spawnSync('bash', ['-e', '-c', drop.run], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);

    assert.equal(existsSync(join(root, 'apps', 'cli', 'node_modules', '@happier-dev')), false);
    assert.equal(existsSync(join(root, 'apps', 'stack', 'node_modules', '@happier-dev')), false);
    assert.equal(existsSync(join(root, 'apps', 'cli', 'node_modules', 'zod', 'package.json')), true);
    assert.equal(existsSync(join(root, 'apps', 'cli', 'node_modules', '@types', 'node', 'package.json')), true);
    assert.equal(existsSync(join(root, 'node_modules', '@happier-dev', 'cli-common', 'package.json')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
