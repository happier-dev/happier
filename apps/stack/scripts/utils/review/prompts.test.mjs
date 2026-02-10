import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCodexDeepPrompt,
  buildCodexNormalPrompt,
  buildCodexMonorepoDeepPrompt,
  buildCodexMonorepoNormalPrompt,
  buildCodexAuditPrompt,
  buildCodexMonorepoAuditPrompt,
  buildCodexMonorepoSlicePrompt,
} from './prompts.mjs';

test('monorepo normal prompt is focused and includes findings JSON marker', () => {
  const prompt = buildCodexMonorepoNormalPrompt({ baseRef: 'upstream/main', changeType: 'uncommitted' });
  assert.match(prompt, /focused code review on the monorepo/i);
  assert.match(prompt, /git diff HEAD/i);
  assert.match(prompt, /===FINDINGS_JSON===/);
  assert.match(prompt, /Do not wait for other agents\/reviewers/i);
  assert.doesNotMatch(prompt, /Be exhaustive/i);
});

test('monorepo deep prompt is exhaustive and includes findings JSON marker', () => {
  const prompt = buildCodexMonorepoDeepPrompt({ baseRef: 'upstream/main', changeType: 'committed' });
  assert.match(prompt, /deep, long-form code review on the monorepo/i);
  assert.match(prompt, /git diff upstream\/main\.\.\.HEAD/i);
  assert.match(prompt, /===FINDINGS_JSON===/);
  assert.match(prompt, /Be exhaustive/i);
});

test('component normal prompt scopes diff to component path', () => {
  const prompt = buildCodexNormalPrompt({ component: 'happier-ui', baseRef: 'upstream/main', changeType: 'committed' });
  assert.match(prompt, /Scope: apps\/ui\//);
  assert.match(prompt, /git diff upstream\/main\.\.\.HEAD -- apps\/ui\//);
});

test('component deep prompt scopes diff to component path', () => {
  const prompt = buildCodexDeepPrompt({ component: 'happier-cli', baseRef: 'upstream/main', changeType: 'committed' });
  assert.match(prompt, /Scope: apps\/cli\//);
  assert.match(prompt, /git diff upstream\/main\.\.\.HEAD -- apps\/cli\//);
});

test('monorepo slice prompt toggles focused vs deep wording', () => {
  const deep = buildCodexMonorepoSlicePrompt({ sliceLabel: 'apps/cli', baseCommit: 'abc123', baseRef: 'upstream/main', deep: true });
  const focused = buildCodexMonorepoSlicePrompt({ sliceLabel: 'apps/cli', baseCommit: 'abc123', baseRef: 'upstream/main', deep: false });
  assert.match(deep, /deep, long-form/i);
  assert.match(focused, /focused code review/i);
});

test('prompts support appending custom focus instructions', () => {
  const prompt = buildCodexMonorepoNormalPrompt({
    baseRef: 'upstream/main',
    changeType: 'uncommitted',
    customPrompt: 'Focus specifically on machine_id_conflict behavior and cross-account machine claiming risks.',
  });
  assert.match(prompt, /Custom focus:/i);
  assert.match(prompt, /machine_id_conflict/i);
  assert.match(prompt, /===FINDINGS_JSON===/);
});

test('audit prompts do not require git diff and include scope paths', () => {
  const prompt = buildCodexMonorepoAuditPrompt({
    deep: true,
    scopePaths: ['apps/cli/src/daemon', 'apps/server/sources/app/api/routes/machines'],
    customPrompt: 'Focus on machine identity invariants across accounts.',
  });
  assert.match(prompt, /Mode: audit/i);
  assert.match(prompt, /Scope paths:/i);
  assert.doesNotMatch(prompt, /git diff/i);
  assert.match(prompt, /===FINDINGS_JSON===/);
});

test('component audit prompt falls back to component scope path when no explicit scope paths provided', () => {
  const prompt = buildCodexAuditPrompt({ component: 'happier-ui', deep: false, scopePaths: [] });
  assert.match(prompt, /Scope paths: apps\/ui/i);
  assert.doesNotMatch(prompt, /git diff/i);
});
