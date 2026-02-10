import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('repo workspaces paths exist on disk', () => {
  const repoRoot = resolve(import.meta.dirname, '..', '..');
  const pkgJsonPath = resolve(repoRoot, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));

  const workspacePkgs = pkg?.workspaces?.packages;
  assert.ok(Array.isArray(workspacePkgs), 'package.json workspaces.packages must be an array');

  const missing = [];
  for (const rel of workspacePkgs) {
    if (typeof rel !== 'string') continue;
    const abs = resolve(repoRoot, rel);
    if (!existsSync(abs)) missing.push(rel);
  }

  assert.deepEqual(
    missing,
    [],
    `workspaces.packages contains paths that do not exist:\n${missing.map((p) => `- ${p}`).join('\n')}`
  );
});

