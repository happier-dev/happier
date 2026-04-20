import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findKnownLlmToolSpecById,
  getKnownLlmToolSpecs,
  resolveLlmToolInteractiveLaunchLine,
  resolveLlmToolPrereqSpec,
} from './registry.mjs';

test('llm registry exposes the canonical tool specs', () => {
  const ids = getKnownLlmToolSpecs().map((spec) => spec.id);
  assert.deepEqual(ids, ['codex', 'claude', 'opencode', 'aider']);
});

test('llm registry resolves prompt-based launch lines and prereq hints', () => {
  const codex = findKnownLlmToolSpecById('codex');
  assert.ok(codex);
  assert.equal(codex.launchMode, 'codex-exec');
  assert.equal(resolveLlmToolInteractiveLaunchLine(codex), 'exec command "codex" "$HS_PROMPT"');

  const claude = findKnownLlmToolSpecById('claude');
  assert.ok(claude);
  assert.equal(resolveLlmToolInteractiveLaunchLine(claude), 'exec command "claude" "$HS_PROMPT"');

  const opencode = findKnownLlmToolSpecById('opencode');
  assert.ok(opencode);
  assert.equal(resolveLlmToolInteractiveLaunchLine(opencode), 'exec command "opencode" --prompt "$HS_PROMPT"');

  const prereq = resolveLlmToolPrereqSpec('codex');
  assert.equal(prereq?.name, 'codex');
  assert.ok(Array.isArray(prereq?.install) && prereq.install.length > 0);
});
