import test from 'node:test';
import assert from 'node:assert/strict';

import { planProviderCliInstall } from '../dist/providers/index.js';

test('planProviderCliInstall returns expected commands for claude/codex/gemini', () => {
  const claude = planProviderCliInstall({ providerId: 'claude', platform: 'darwin' });
  assert.equal(claude.ok, true);
  assert.ok(JSON.stringify(claude.plan).includes('claude.ai/install.sh'));

  const codex = planProviderCliInstall({ providerId: 'codex', platform: 'linux' });
  assert.equal(codex.ok, true);
  assert.ok(JSON.stringify(codex.plan).includes('@openai/codex'));

  const gemini = planProviderCliInstall({ providerId: 'gemini', platform: 'win32' });
  assert.equal(gemini.ok, true);
  assert.ok(JSON.stringify(gemini.plan).includes('@google/gemini-cli'));
});

test('planProviderCliInstall includes requiresAdmin hint for qwen windows recipe', () => {
  const qwen = planProviderCliInstall({ providerId: 'qwen', platform: 'win32' });
  assert.equal(qwen.ok, true);
  assert.equal(Boolean(qwen.plan.requiresAdmin), true);
});

