import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function readRepoFile(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

test('public release skills bootstrap the private release authority instead of retaining an independent policy', () => {
  for (const skillPath of [
    '.agents/skills/happier-release/SKILL.md',
    '.agents/skills/happier-release-promote/SKILL.md',
    '.agents/skills/happier-release-validation/SKILL.md',
    '.agents/skills/happier-release-validation-review/SKILL.md',
  ]) {
    const skill = readRepoFile(skillPath);
    assert.match(skill, /hmaint release bootstrap --repo <absolute checkout> --json/);
    assert.match(skill, /returned private skill/i);
    assert.doesNotMatch(skill, /references\/(workflow|lane-catalog|manual-qa-matrix|review-rubric)\.md/);
  }
});

test('public release and compatibility docs point operators to the contract and human approval boundary', () => {
  const releaseProcess = readRepoFile('docs/release-process.md');
  const compatibility = readRepoFile('docs/compatibility.md');

  assert.match(releaseProcess, /release-contract/);
  assert.match(releaseProcess, /human go-ahead/i);
  assert.match(releaseProcess, /exact SHA/i);
  assert.match(releaseProcess, /integrated/);
  assert.match(releaseProcess, /stable/);
  assert.match(releaseProcess, /deep/);
  assert.match(compatibility, /self-hosted/i);
  assert.match(compatibility, /independent upgrade/i);
  assert.match(compatibility, /rollback or\s+coexistence/i);
});
