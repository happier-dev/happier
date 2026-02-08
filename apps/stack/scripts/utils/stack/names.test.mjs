import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeStackNameOrNull } from './names.mjs';

test('normalizeStackNameOrNull normalizes to a DNS-safe label', () => {
  assert.equal(normalizeStackNameOrNull('My Stack'), 'my-stack');
});

test('normalizeStackNameOrNull returns null when the name sanitizes to empty', () => {
  assert.equal(normalizeStackNameOrNull('----'), null);
});

test('normalizeStackNameOrNull returns null when the name exceeds maxLen', () => {
  const long = 'a'.repeat(64);
  assert.equal(normalizeStackNameOrNull(long), null);
});

test('normalizeStackNameOrNull accepts a 63-character DNS-safe label', () => {
  const max = 'a'.repeat(63);
  assert.equal(normalizeStackNameOrNull(max), max);
});

test('normalizeStackNameOrNull collapses punctuation runs into single separators', () => {
  assert.equal(normalizeStackNameOrNull('My__Stack...Name'), 'my-stack-name');
});
