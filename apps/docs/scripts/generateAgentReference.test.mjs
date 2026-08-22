import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { sessionModesKind } from './generateAgentReference.mjs';

test('derives the mode kind from source and semantics', () => {
  assert.equal(sessionModesKind({ source: 'provider-native', semantics: 'agent-modes' }), 'staticAgentModes');
  assert.equal(sessionModesKind({ source: 'acp', semantics: 'agent-modes' }), 'acpAgentModes');
  assert.equal(sessionModesKind({ source: 'acp', semantics: 'policy-presets' }), 'acpPolicyPresets');
  assert.equal(sessionModesKind({ source: 'none', semantics: 'none' }), 'none');
});

test("classifies Codex as policy presets rather than as having no modes", () => {
  // Codex reaches plan mode through ACP policy presets. `supportsPlanMode` is
  // derived elsewhere as `semantics === 'agent-modes'` and so reads false for
  // it, which is why this page describes the descriptor instead of that flag.
  assert.equal(sessionModesKind({ source: 'acp', semantics: 'policy-presets', runtimeSwitch: 'metadata-gating' }), 'acpPolicyPresets');
});

test('treats a missing descriptor as no modes rather than throwing', () => {
  assert.equal(sessionModesKind(undefined), 'none');
});
