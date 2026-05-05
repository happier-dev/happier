import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

function escapeRegex(value) {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function segmentPatternToRegex(pattern) {
  const source = Array.from(pattern)
    .map((char) => {
      if (char === '*') return '.*';
      return escapeRegex(char);
    })
    .join('')
    .replace(/\\\[a-z\\\]/g, '[a-z]');

  return new RegExp(`^${source}$`);
}

function workspacePathExists(repoRoot, rel) {
  const literalPath = resolve(repoRoot, rel);
  if (existsSync(literalPath)) return true;
  if (!/[*[]/.test(rel)) return false;

  const parentPath = resolve(repoRoot, dirname(rel));
  if (!existsSync(parentPath)) return false;

  const pattern = segmentPatternToRegex(basename(rel));
  return readdirSync(parentPath, { withFileTypes: true }).some((entry) => {
    if (!entry.isDirectory()) return false;
    return pattern.test(entry.name) && existsSync(resolve(parentPath, entry.name, 'package.json'));
  });
}

test('repo workspaces paths exist on disk', () => {
  const repoRoot = resolve(import.meta.dirname, '..', '..');
  const pkgJsonPath = resolve(repoRoot, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));

  const workspacePkgs = pkg?.workspaces?.packages;
  assert.ok(Array.isArray(workspacePkgs), 'package.json workspaces.packages must be an array');

  const missing = [];
  for (const rel of workspacePkgs) {
    if (typeof rel !== 'string') continue;
    if (!workspacePathExists(repoRoot, rel)) missing.push(rel);
  }

  assert.deepEqual(
    missing,
    [],
    `workspaces.packages contains paths that do not exist:\n${missing.map((p) => `- ${p}`).join('\n')}`
  );
});
